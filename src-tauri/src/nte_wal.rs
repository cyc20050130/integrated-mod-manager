use sha2::{Digest, Sha256};
use std::fmt;
use std::fs::OpenOptions;
use std::io::{Read, Seek, SeekFrom, Write};
use std::path::Path;
use std::sync::atomic::{AtomicU64, Ordering};
use std::time::{SystemTime, UNIX_EPOCH};

const WAL_MAGIC: [u8; 8] = *b"IMMNTEW1";
const WAL_SCHEMA_VERSION: u16 = 1;
const PREFIX_LEN: usize = WAL_MAGIC.len() + size_of::<u32>();
const TRANSACTION_ID_LEN: usize = 16;
const HASH_LEN: usize = 32;
const FIXED_BODY_LEN: usize = size_of::<u16>()
    + size_of::<u8>()
    + size_of::<u8>()
    + TRANSACTION_ID_LEN
    + size_of::<u64>()
    + HASH_LEN
    + HASH_LEN
    + size_of::<u32>();
const RECORD_HASH_LEN: usize = HASH_LEN;
const MIN_STORED_BODY_LEN: usize = FIXED_BODY_LEN + RECORD_HASH_LEN;
const MAX_PAYLOAD_LEN: usize = 1024 * 1024;
const MAX_STORED_BODY_LEN: usize = FIXED_BODY_LEN + MAX_PAYLOAD_LEN + RECORD_HASH_LEN;
const MAX_WAL_FILE_LEN: u64 = 64 * 1024 * 1024;
static TRANSACTION_COUNTER: AtomicU64 = AtomicU64::new(0);
#[cfg(test)]
thread_local! {
    static APPEND_FLUSH_FAULT: std::cell::Cell<Option<(WalState, FlushFaultPhase)>> = const { std::cell::Cell::new(None) };
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
#[repr(u8)]
pub(crate) enum WalState {
    Prepared = 1,
    Committing = 2,
    StepReceipt = 3,
    PausedExternalProcess = 4,
    CommittedAfter = 5,
    CleanupComplete = 6,
    AbortedBefore = 7,
}

#[cfg(test)]
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum FlushFaultPhase {
    Before,
    After,
}

impl TryFrom<u8> for WalState {
    type Error = ();

    fn try_from(value: u8) -> Result<Self, Self::Error> {
        match value {
            1 => Ok(Self::Prepared),
            2 => Ok(Self::Committing),
            3 => Ok(Self::StepReceipt),
            4 => Ok(Self::PausedExternalProcess),
            5 => Ok(Self::CommittedAfter),
            6 => Ok(Self::CleanupComplete),
            7 => Ok(Self::AbortedBefore),
            _ => Err(()),
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
struct WalRecord {
    transaction_id: [u8; TRANSACTION_ID_LEN],
    sequence: u64,
    prior_record_hash: [u8; HASH_LEN],
    payload_sha256: [u8; HASH_LEN],
    state: WalState,
    payload: Vec<u8>,
    record_hash: [u8; HASH_LEN],
}

pub(crate) struct WalJournal {
    file: std::fs::File,
    next_sequence: u64,
    prior_record_hash: [u8; HASH_LEN],
    active_transaction_id: Option<[u8; TRANSACTION_ID_LEN]>,
    active_state: Option<WalState>,
    poisoned: bool,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct IncompleteTransaction {
    pub(crate) transaction_id: [u8; TRANSACTION_ID_LEN],
    pub(crate) state: WalState,
    pub(crate) prepared_payload: Vec<u8>,
}

#[cfg(test)]
#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct WalScanSummary {
    pub(crate) valid_records: usize,
    pub(crate) valid_bytes: u64,
    pub(crate) repaired_tail: bool,
}

#[derive(Debug, Clone, PartialEq, Eq)]
enum ScanOutcome {
    Clean(Vec<WalRecord>),
    RepairTail {
        records: Vec<WalRecord>,
        truncate_to: usize,
    },
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct WalCorruption {
    offset: usize,
    reason: String,
}

impl fmt::Display for WalCorruption {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(
            formatter,
            "NTE transaction WAL is corrupt at byte {}: {}. Repair is required before changing Mods.",
            self.offset, self.reason
        )
    }
}

fn sha256(bytes: &[u8]) -> [u8; HASH_LEN] {
    Sha256::digest(bytes).into()
}

fn new_transaction_id() -> Result<[u8; TRANSACTION_ID_LEN], String> {
    let now = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map_err(|err| format!("System clock cannot create an NTE transaction ID: {err}"))?;
    let counter = TRANSACTION_COUNTER.fetch_add(1, Ordering::SeqCst) + 1;
    let mut entropy = Vec::with_capacity(28);
    entropy.extend_from_slice(&std::process::id().to_le_bytes());
    entropy.extend_from_slice(&counter.to_le_bytes());
    entropy.extend_from_slice(&now.as_nanos().to_le_bytes());
    let digest = sha256(&entropy);
    Ok(digest[..TRANSACTION_ID_LEN].try_into().unwrap())
}

fn encode_frame(
    transaction_id: [u8; TRANSACTION_ID_LEN],
    sequence: u64,
    prior_record_hash: [u8; HASH_LEN],
    state: WalState,
    payload: &[u8],
) -> Result<(Vec<u8>, [u8; HASH_LEN]), String> {
    if payload.len() > MAX_PAYLOAD_LEN {
        return Err(format!(
            "NTE transaction WAL payload exceeds the {} byte limit.",
            MAX_PAYLOAD_LEN
        ));
    }
    let stored_body_len = FIXED_BODY_LEN + payload.len() + RECORD_HASH_LEN;
    let mut frame = Vec::with_capacity(PREFIX_LEN + stored_body_len);
    frame.extend_from_slice(&WAL_MAGIC);
    frame.extend_from_slice(&(stored_body_len as u32).to_le_bytes());
    frame.extend_from_slice(&WAL_SCHEMA_VERSION.to_le_bytes());
    frame.push(state as u8);
    frame.push(0);
    frame.extend_from_slice(&transaction_id);
    frame.extend_from_slice(&sequence.to_le_bytes());
    frame.extend_from_slice(&prior_record_hash);
    frame.extend_from_slice(&sha256(payload));
    frame.extend_from_slice(&(payload.len() as u32).to_le_bytes());
    frame.extend_from_slice(payload);
    let record_hash = sha256(&frame);
    frame.extend_from_slice(&record_hash);
    Ok((frame, record_hash))
}

fn read_u16(bytes: &[u8], offset: usize) -> u16 {
    u16::from_le_bytes(bytes[offset..offset + size_of::<u16>()].try_into().unwrap())
}

fn read_u32(bytes: &[u8], offset: usize) -> u32 {
    u32::from_le_bytes(bytes[offset..offset + size_of::<u32>()].try_into().unwrap())
}

fn read_u64(bytes: &[u8], offset: usize) -> u64 {
    u64::from_le_bytes(bytes[offset..offset + size_of::<u64>()].try_into().unwrap())
}

fn copy_array<const N: usize>(bytes: &[u8]) -> [u8; N] {
    bytes.try_into().unwrap()
}

fn stored_body_len(data: &[u8], offset: usize) -> Option<usize> {
    let length_offset = offset.checked_add(WAL_MAGIC.len())?;
    let length_end = length_offset.checked_add(size_of::<u32>())?;
    if length_end > data.len() {
        return None;
    }
    usize::try_from(read_u32(data, length_offset)).ok()
}

fn parse_complete_frame(data: &[u8], offset: usize) -> Result<(WalRecord, usize), String> {
    let prefix_end = offset
        .checked_add(PREFIX_LEN)
        .ok_or_else(|| "frame offset overflow".to_string())?;
    if prefix_end > data.len() {
        return Err("incomplete frame prefix".to_string());
    }
    if data[offset..offset + WAL_MAGIC.len()] != WAL_MAGIC {
        return Err("invalid frame magic".to_string());
    }
    let body_len =
        stored_body_len(data, offset).ok_or_else(|| "missing frame length".to_string())?;
    if !(MIN_STORED_BODY_LEN..=MAX_STORED_BODY_LEN).contains(&body_len) {
        return Err("frame length is outside the allowed range".to_string());
    }
    let frame_end = prefix_end
        .checked_add(body_len)
        .ok_or_else(|| "frame length overflow".to_string())?;
    if frame_end > data.len() {
        return Err("incomplete frame body".to_string());
    }

    let body = &data[prefix_end..frame_end];
    let schema_version = read_u16(body, 0);
    if schema_version != WAL_SCHEMA_VERSION {
        return Err(format!("unsupported schema version {schema_version}"));
    }
    let state = WalState::try_from(body[2]).map_err(|_| "invalid WAL state".to_string())?;
    if body[3] != 0 {
        return Err("unsupported frame flags".to_string());
    }
    let transaction_id = copy_array(&body[4..4 + TRANSACTION_ID_LEN]);
    let sequence_offset = 4 + TRANSACTION_ID_LEN;
    let sequence = read_u64(body, sequence_offset);
    let prior_hash_offset = sequence_offset + size_of::<u64>();
    let prior_record_hash = copy_array(&body[prior_hash_offset..prior_hash_offset + HASH_LEN]);
    let payload_hash_offset = prior_hash_offset + HASH_LEN;
    let payload_sha256 = copy_array(&body[payload_hash_offset..payload_hash_offset + HASH_LEN]);
    let payload_len_offset = payload_hash_offset + HASH_LEN;
    let payload_len = usize::try_from(read_u32(body, payload_len_offset))
        .map_err(|_| "payload length does not fit this platform".to_string())?;
    if payload_len > MAX_PAYLOAD_LEN {
        return Err("payload exceeds the WAL limit".to_string());
    }
    let expected_body_len = FIXED_BODY_LEN
        .checked_add(payload_len)
        .and_then(|value| value.checked_add(RECORD_HASH_LEN))
        .ok_or_else(|| "payload length overflow".to_string())?;
    if expected_body_len != body_len {
        return Err("frame and payload lengths disagree".to_string());
    }
    let payload_offset = FIXED_BODY_LEN;
    let payload_end = payload_offset + payload_len;
    let payload = body[payload_offset..payload_end].to_vec();
    if sha256(&payload) != payload_sha256 {
        return Err("payload SHA-256 mismatch".to_string());
    }
    let record_hash = copy_array(&body[payload_end..payload_end + RECORD_HASH_LEN]);
    if sha256(&data[offset..prefix_end + payload_end]) != record_hash {
        return Err("record SHA-256 mismatch".to_string());
    }

    Ok((
        WalRecord {
            transaction_id,
            sequence,
            prior_record_hash,
            payload_sha256,
            state,
            payload,
            record_hash,
        },
        frame_end,
    ))
}

fn has_independently_valid_frame_after(data: &[u8], offset: usize) -> bool {
    let Some(mut candidate) = offset.checked_add(1) else {
        return false;
    };
    while candidate.saturating_add(PREFIX_LEN + MIN_STORED_BODY_LEN) <= data.len() {
        if data[candidate..].starts_with(&WAL_MAGIC)
            && parse_complete_frame(data, candidate).is_ok()
        {
            return true;
        }
        candidate += 1;
    }
    false
}

fn tail_or_interior(
    data: &[u8],
    offset: usize,
    records: Vec<WalRecord>,
    reason: impl Into<String>,
) -> Result<ScanOutcome, WalCorruption> {
    let reason = reason.into();
    if has_independently_valid_frame_after(data, offset) {
        Err(WalCorruption { offset, reason })
    } else {
        Ok(ScanOutcome::RepairTail {
            records,
            truncate_to: offset,
        })
    }
}

fn scan_bytes(data: &[u8]) -> Result<ScanOutcome, WalCorruption> {
    let mut records = Vec::new();
    let mut offset = 0usize;
    let mut expected_sequence = 1u64;
    let mut expected_prior_hash = [0u8; HASH_LEN];
    let mut active_transaction_id = None;
    let mut active_state = None;

    while offset < data.len() {
        if data.len() - offset < PREFIX_LEN {
            let remaining = &data[offset..];
            let is_valid_prefix = if remaining.len() <= WAL_MAGIC.len() {
                WAL_MAGIC.starts_with(remaining)
            } else {
                remaining.starts_with(&WAL_MAGIC)
            };
            if is_valid_prefix {
                return tail_or_interior(data, offset, records, "incomplete frame prefix");
            }
            return Err(WalCorruption {
                offset,
                reason: "invalid frame magic".to_string(),
            });
        }
        if !data[offset..].starts_with(&WAL_MAGIC) {
            if records.is_empty() {
                return Err(WalCorruption {
                    offset,
                    reason: "invalid frame magic".to_string(),
                });
            }
            return tail_or_interior(data, offset, records, "invalid frame magic");
        }
        let Some(body_len) = stored_body_len(data, offset) else {
            return tail_or_interior(data, offset, records, "missing frame length");
        };
        if !(MIN_STORED_BODY_LEN..=MAX_STORED_BODY_LEN).contains(&body_len) {
            return tail_or_interior(
                data,
                offset,
                records,
                "frame length is outside the allowed range",
            );
        }
        let Some(frame_end) = offset
            .checked_add(PREFIX_LEN)
            .and_then(|value| value.checked_add(body_len))
        else {
            return Err(WalCorruption {
                offset,
                reason: "frame length overflow".to_string(),
            });
        };
        if frame_end > data.len() {
            return tail_or_interior(data, offset, records, "incomplete frame body");
        }

        let (record, parsed_end) = parse_complete_frame(data, offset)
            .map_err(|reason| WalCorruption { offset, reason })?;
        if record.sequence != expected_sequence {
            return Err(WalCorruption {
                offset,
                reason: format!(
                    "sequence gap: expected {expected_sequence}, found {}",
                    record.sequence
                ),
            });
        }
        if record.prior_record_hash != expected_prior_hash {
            return Err(WalCorruption {
                offset,
                reason: "prior-record hash chain mismatch".to_string(),
            });
        }
        validate_state_transition(
            active_transaction_id,
            active_state,
            record.transaction_id,
            record.state,
        )
        .map_err(|reason| WalCorruption { offset, reason })?;
        if record.state == WalState::CleanupComplete {
            active_transaction_id = None;
            active_state = None;
        } else {
            active_transaction_id = Some(record.transaction_id);
            active_state = Some(record.state);
        }
        expected_sequence = expected_sequence
            .checked_add(1)
            .ok_or_else(|| WalCorruption {
                offset,
                reason: "sequence overflow".to_string(),
            })?;
        expected_prior_hash = record.record_hash;
        records.push(record);
        offset = parsed_end;
    }

    Ok(ScanOutcome::Clean(records))
}

fn validate_state_transition(
    active_transaction_id: Option<[u8; TRANSACTION_ID_LEN]>,
    active_state: Option<WalState>,
    transaction_id: [u8; TRANSACTION_ID_LEN],
    next_state: WalState,
) -> Result<(), String> {
    match (active_transaction_id, active_state) {
        (None, None) if next_state == WalState::Prepared => Ok(()),
        (None, None) => Err("a transaction must start with prepared".to_string()),
        (Some(active_id), Some(_)) if active_id != transaction_id => {
            Err("a new transaction started before the active transaction committed".to_string())
        }
        (Some(_), Some(WalState::Prepared)) if next_state == WalState::Committing => Ok(()),
        (Some(_), Some(WalState::Committing))
            if matches!(
                next_state,
                WalState::StepReceipt
                    | WalState::PausedExternalProcess
                    | WalState::CommittedAfter
                    | WalState::AbortedBefore
            ) =>
        {
            Ok(())
        }
        (Some(_), Some(WalState::StepReceipt | WalState::PausedExternalProcess))
            if matches!(
                next_state,
                WalState::StepReceipt
                    | WalState::PausedExternalProcess
                    | WalState::CommittedAfter
                    | WalState::AbortedBefore
            ) =>
        {
            Ok(())
        }
        (Some(_), Some(WalState::CommittedAfter | WalState::AbortedBefore))
            if next_state == WalState::CleanupComplete =>
        {
            Ok(())
        }
        (Some(_), Some(previous)) => Err(format!(
            "invalid WAL state transition from {previous:?} to {next_state:?}"
        )),
        _ => Err("inconsistent active transaction state".to_string()),
    }
}

fn records_from_outcome(outcome: ScanOutcome) -> (Vec<WalRecord>, Option<usize>) {
    match outcome {
        ScanOutcome::Clean(records) => (records, None),
        ScanOutcome::RepairTail {
            records,
            truncate_to,
        } => (records, Some(truncate_to)),
    }
}

fn active_transaction(
    records: &[WalRecord],
) -> (Option<[u8; TRANSACTION_ID_LEN]>, Option<WalState>) {
    let Some(last) = records.last() else {
        return (None, None);
    };
    if last.state == WalState::CleanupComplete {
        (None, None)
    } else {
        (Some(last.transaction_id), Some(last.state))
    }
}

impl WalJournal {
    pub(crate) fn open(path: &Path) -> Result<Self, String> {
        let mut file = OpenOptions::new()
            .read(true)
            .write(true)
            .create(true)
            .truncate(false)
            .open(path)
            .map_err(|err| format!("Unable to open the NTE transaction WAL: {err}"))?;
        let length = file
            .metadata()
            .map_err(|err| format!("Unable to inspect the NTE transaction WAL: {err}"))?
            .len();
        if length > MAX_WAL_FILE_LEN {
            return Err(format!(
                "NTE transaction WAL exceeds the {} MiB safety limit. Repair is required before changing Mods.",
                MAX_WAL_FILE_LEN / 1024 / 1024
            ));
        }
        let mut data = Vec::with_capacity(length as usize);
        file.read_to_end(&mut data)
            .map_err(|err| format!("Unable to read the NTE transaction WAL: {err}"))?;
        let (mut records, truncate_to) =
            records_from_outcome(scan_bytes(&data).map_err(|err| err.to_string())?);
        if let Some(truncate_to) = truncate_to {
            file.set_len(truncate_to as u64)
                .map_err(|err| format!("Unable to truncate the torn NTE transaction WAL: {err}"))?;
            file.sync_all().map_err(|err| {
                format!("Unable to flush the repaired NTE transaction WAL: {err}")
            })?;
        }
        let (active_transaction_id, _) = active_transaction(&records);
        if !records.is_empty() && active_transaction_id.is_none() {
            file.set_len(0)
                .map_err(|err| format!("Unable to checkpoint the completed NTE WAL: {err}"))?;
            file.sync_all()
                .map_err(|err| format!("Unable to flush the NTE WAL checkpoint: {err}"))?;
            records.clear();
        }
        let next_sequence = records.last().map_or(Ok(1), |record| {
            record
                .sequence
                .checked_add(1)
                .ok_or_else(|| "NTE transaction WAL sequence overflow.".to_string())
        })?;
        let prior_record_hash = records
            .last()
            .map_or([0; HASH_LEN], |record| record.record_hash);
        let (active_transaction_id, active_state) = active_transaction(&records);
        file.seek(SeekFrom::End(0))
            .map_err(|err| format!("Unable to seek the NTE transaction WAL: {err}"))?;
        Ok(Self {
            file,
            next_sequence,
            prior_record_hash,
            active_transaction_id,
            active_state,
            poisoned: false,
        })
    }

    pub(crate) fn begin(&mut self, payload: &[u8]) -> Result<[u8; TRANSACTION_ID_LEN], String> {
        if self.active_transaction_id.is_some() {
            return Err(
                "An incomplete NTE transaction requires recovery before a new operation."
                    .to_string(),
            );
        }
        let transaction_id = new_transaction_id()?;
        self.append(transaction_id, WalState::Prepared, payload)?;
        Ok(transaction_id)
    }

    pub(crate) fn incomplete_transaction(
        &mut self,
    ) -> Result<Option<IncompleteTransaction>, String> {
        let Some(transaction_id) = self.active_transaction_id else {
            return Ok(None);
        };
        let state = self
            .active_state
            .ok_or_else(|| "NTE transaction WAL active state is inconsistent.".to_string())?;
        self.file
            .seek(SeekFrom::Start(0))
            .map_err(|err| format!("Unable to seek the NTE transaction WAL: {err}"))?;
        let mut data = Vec::new();
        self.file
            .read_to_end(&mut data)
            .map_err(|err| format!("Unable to read the NTE transaction WAL: {err}"))?;
        self.file
            .seek(SeekFrom::End(0))
            .map_err(|err| format!("Unable to seek the NTE transaction WAL: {err}"))?;
        let (records, _) = records_from_outcome(scan_bytes(&data).map_err(|err| err.to_string())?);
        let prepared_payload = records
            .iter()
            .rev()
            .find(|record| {
                record.transaction_id == transaction_id && record.state == WalState::Prepared
            })
            .map(|record| record.payload.clone())
            .ok_or_else(|| {
                "NTE transaction WAL has no prepared record for the active transaction.".to_string()
            })?;
        Ok(Some(IncompleteTransaction {
            transaction_id,
            state,
            prepared_payload,
        }))
    }

    pub(crate) fn append(
        &mut self,
        transaction_id: [u8; TRANSACTION_ID_LEN],
        state: WalState,
        payload: &[u8],
    ) -> Result<(), String> {
        if self.poisoned {
            return Err(
                "NTE transaction WAL append state is uncertain; close and reopen it before recovery."
                    .to_string(),
            );
        }
        validate_state_transition(
            self.active_transaction_id,
            self.active_state,
            transaction_id,
            state,
        )?;
        let (frame, record_hash) = encode_frame(
            transaction_id,
            self.next_sequence,
            self.prior_record_hash,
            state,
            payload,
        )?;
        let new_length = self
            .file
            .metadata()
            .map_err(|err| format!("Unable to inspect the NTE transaction WAL: {err}"))?
            .len()
            .checked_add(frame.len() as u64)
            .ok_or_else(|| "NTE transaction WAL length overflow.".to_string())?;
        if new_length > MAX_WAL_FILE_LEN {
            return Err("NTE transaction WAL is full; checkpoint repair is required.".to_string());
        }
        if let Err(err) = self.file.write_all(&frame) {
            self.poisoned = true;
            return Err(format!("Unable to append the NTE transaction WAL: {err}"));
        }
        #[cfg(test)]
        if append_flush_fault_matches(state, FlushFaultPhase::Before) {
            self.poisoned = true;
            return Err(format!(
                "Injected NTE transaction WAL fault before flushing {state:?}."
            ));
        }
        if let Err(err) = self.file.sync_all() {
            self.poisoned = true;
            return Err(format!("Unable to flush the NTE transaction WAL: {err}"));
        }
        #[cfg(test)]
        if append_flush_fault_matches(state, FlushFaultPhase::After) {
            self.poisoned = true;
            return Err(format!(
                "Injected NTE transaction WAL fault after flushing {state:?}."
            ));
        }
        self.next_sequence = self
            .next_sequence
            .checked_add(1)
            .ok_or_else(|| "NTE transaction WAL sequence overflow.".to_string())?;
        self.prior_record_hash = record_hash;
        if state == WalState::CleanupComplete {
            self.active_transaction_id = None;
            self.active_state = None;
        } else {
            self.active_transaction_id = Some(transaction_id);
            self.active_state = Some(state);
        }
        Ok(())
    }
}

#[cfg(test)]
fn append_flush_fault_matches(state: WalState, phase: FlushFaultPhase) -> bool {
    APPEND_FLUSH_FAULT.with(|fault| fault.get() == Some((state, phase)))
}

#[cfg(test)]
pub(crate) struct WalFaultGuard;

#[cfg(test)]
impl Drop for WalFaultGuard {
    fn drop(&mut self) {
        APPEND_FLUSH_FAULT.with(|fault| fault.set(None));
    }
}

#[cfg(test)]
pub(crate) fn inject_pause_flush_fault(after_flush: bool) -> WalFaultGuard {
    APPEND_FLUSH_FAULT.with(|fault| {
        fault.set(Some((
            WalState::PausedExternalProcess,
            if after_flush {
                FlushFaultPhase::After
            } else {
                FlushFaultPhase::Before
            },
        )))
    });
    WalFaultGuard
}

#[cfg(test)]
pub(crate) fn validate_or_repair(path: &Path) -> Result<WalScanSummary, String> {
    let mut file = match OpenOptions::new().read(true).write(true).open(path) {
        Ok(file) => file,
        Err(err) if err.kind() == std::io::ErrorKind::NotFound => {
            return Ok(WalScanSummary {
                valid_records: 0,
                valid_bytes: 0,
                repaired_tail: false,
            });
        }
        Err(err) => return Err(format!("Unable to open the NTE transaction WAL: {err}")),
    };
    let length = file
        .metadata()
        .map_err(|err| format!("Unable to inspect the NTE transaction WAL: {err}"))?
        .len();
    if length > MAX_WAL_FILE_LEN {
        return Err(format!(
            "NTE transaction WAL exceeds the {} MiB safety limit. Repair is required before changing Mods.",
            MAX_WAL_FILE_LEN / 1024 / 1024
        ));
    }
    let mut data = Vec::with_capacity(length as usize);
    file.read_to_end(&mut data)
        .map_err(|err| format!("Unable to read the NTE transaction WAL: {err}"))?;
    match scan_bytes(&data).map_err(|err| err.to_string())? {
        ScanOutcome::Clean(records) => Ok(WalScanSummary {
            valid_records: records.len(),
            valid_bytes: length,
            repaired_tail: false,
        }),
        ScanOutcome::RepairTail {
            records,
            truncate_to,
        } => {
            file.set_len(truncate_to as u64)
                .map_err(|err| format!("Unable to truncate the torn NTE transaction WAL: {err}"))?;
            file.seek(SeekFrom::Start(truncate_to as u64))
                .map_err(|err| format!("Unable to seek the repaired NTE transaction WAL: {err}"))?;
            file.sync_all().map_err(|err| {
                format!("Unable to flush the repaired NTE transaction WAL: {err}")
            })?;
            Ok(WalScanSummary {
                valid_records: records.len(),
                valid_bytes: truncate_to as u64,
                repaired_tail: true,
            })
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;
    use tempfile::tempdir;

    fn encode_record(
        transaction_id: [u8; TRANSACTION_ID_LEN],
        sequence: u64,
        prior_record_hash: [u8; HASH_LEN],
        state: WalState,
        payload: &[u8],
    ) -> (Vec<u8>, [u8; HASH_LEN]) {
        encode_frame(transaction_id, sequence, prior_record_hash, state, payload).unwrap()
    }

    fn sample_chain() -> (Vec<Vec<u8>>, Vec<u8>) {
        let transaction_id = [0x42; TRANSACTION_ID_LEN];
        let mut prior = [0; HASH_LEN];
        let mut frames = Vec::new();
        for (sequence, state, payload) in [
            (
                1,
                WalState::Prepared,
                br#"{"operation":"enable"}"#.as_slice(),
            ),
            (2, WalState::Committing, br#"{"step":"begin"}"#.as_slice()),
            (3, WalState::StepReceipt, br#"{"step":"rename"}"#.as_slice()),
            (
                4,
                WalState::CommittedAfter,
                br#"{"result":"ok"}"#.as_slice(),
            ),
            (
                5,
                WalState::CleanupComplete,
                br#"{"cleanup":"complete"}"#.as_slice(),
            ),
        ] {
            let (frame, record_hash) =
                encode_record(transaction_id, sequence, prior, state, payload);
            prior = record_hash;
            frames.push(frame);
        }
        let bytes = frames.concat();
        (frames, bytes)
    }

    #[test]
    fn valid_chain_round_trips() {
        let (_, bytes) = sample_chain();
        let ScanOutcome::Clean(records) = scan_bytes(&bytes).unwrap() else {
            panic!("complete WAL should not need repair");
        };
        assert_eq!(records.len(), 5);
        assert_eq!(records[0].sequence, 1);
        assert_eq!(records[4].state, WalState::CleanupComplete);
    }

    #[test]
    fn every_byte_truncation_keeps_only_proven_frames() {
        let (frames, bytes) = sample_chain();
        let boundaries: Vec<usize> = frames
            .iter()
            .scan(0usize, |total, frame| {
                *total += frame.len();
                Some(*total)
            })
            .collect();

        assert!(
            matches!(scan_bytes(&[]).unwrap(), ScanOutcome::Clean(records) if records.is_empty())
        );
        for cut in 1..bytes.len() {
            let expected_valid_bytes = boundaries
                .iter()
                .copied()
                .take_while(|boundary| *boundary <= cut)
                .last()
                .unwrap_or(0);
            match scan_bytes(&bytes[..cut]).unwrap() {
                ScanOutcome::Clean(records) => {
                    assert_eq!(cut, expected_valid_bytes, "cut={cut}");
                    assert_eq!(
                        records.len(),
                        boundaries.iter().filter(|b| **b <= cut).count()
                    );
                }
                ScanOutcome::RepairTail {
                    records,
                    truncate_to,
                } => {
                    assert_eq!(truncate_to, expected_valid_bytes, "cut={cut}");
                    assert_eq!(
                        records.len(),
                        boundaries.iter().filter(|b| **b <= cut).count()
                    );
                }
            }
        }
    }

    #[test]
    fn bit_flips_in_each_field_and_payload_fail_closed() {
        let (frames, bytes) = sample_chain();
        let second_offset = frames[0].len();
        let second_payload_offset = second_offset + PREFIX_LEN + FIXED_BODY_LEN;
        let second_record_hash_offset = second_offset + frames[1].len() - RECORD_HASH_LEN;
        let field_offsets = [
            second_offset,
            second_offset + WAL_MAGIC.len(),
            second_offset + PREFIX_LEN,
            second_offset + PREFIX_LEN + 2,
            second_offset + PREFIX_LEN + 3,
            second_offset + PREFIX_LEN + 4,
            second_offset + PREFIX_LEN + 4 + TRANSACTION_ID_LEN,
            second_offset + PREFIX_LEN + 4 + TRANSACTION_ID_LEN + size_of::<u64>(),
            second_offset + PREFIX_LEN + 4 + TRANSACTION_ID_LEN + size_of::<u64>() + HASH_LEN,
            second_offset + PREFIX_LEN + FIXED_BODY_LEN - size_of::<u32>(),
            second_payload_offset,
            second_record_hash_offset,
        ];

        for field_offset in field_offsets {
            let mut corrupted = bytes.clone();
            corrupted[field_offset] ^= 0x01;
            let error = scan_bytes(&corrupted).unwrap_err();
            assert!(
                error.offset <= second_offset,
                "offset={field_offset}: {error}"
            );
        }
    }

    #[test]
    fn duplicated_reordered_and_sequence_gap_records_fail_closed() {
        let (frames, _) = sample_chain();

        let duplicated = [
            frames[0].as_slice(),
            frames[1].as_slice(),
            frames[1].as_slice(),
            frames[2].as_slice(),
        ]
        .concat();
        assert!(scan_bytes(&duplicated).is_err());

        let reordered = [
            frames[0].as_slice(),
            frames[2].as_slice(),
            frames[1].as_slice(),
        ]
        .concat();
        assert!(scan_bytes(&reordered).is_err());

        let transaction_id = [0x24; TRANSACTION_ID_LEN];
        let (first, first_hash) =
            encode_record(transaction_id, 1, [0; HASH_LEN], WalState::Prepared, b"{}");
        let (third, _) = encode_record(
            transaction_id,
            3,
            first_hash,
            WalState::CommittedAfter,
            b"{}",
        );
        assert!(scan_bytes(&[first, third].concat()).is_err());
    }

    #[test]
    fn repair_truncates_and_flushes_only_the_torn_tail() {
        let (frames, bytes) = sample_chain();
        let trusted_len = frames[0].len() + frames[1].len();
        let torn_len = trusted_len + frames[2].len() / 2;
        let temp = tempdir().unwrap();
        let wal_path = temp.path().join("transactions.wal");
        fs::write(&wal_path, &bytes[..torn_len]).unwrap();

        let summary = validate_or_repair(&wal_path).unwrap();

        assert_eq!(summary.valid_records, 2);
        assert_eq!(summary.valid_bytes, trusted_len as u64);
        assert!(summary.repaired_tail);
        assert_eq!(fs::metadata(wal_path).unwrap().len(), trusted_len as u64);
    }

    #[test]
    fn complete_corruption_is_not_silently_truncated() {
        let (_, mut bytes) = sample_chain();
        let last = bytes.len() - 1;
        bytes[last] ^= 0x80;
        let error = scan_bytes(&bytes).unwrap_err();
        assert!(error.reason.contains("record SHA-256"));
    }

    #[test]
    fn untrusted_first_frame_and_random_file_fail_closed() {
        let (_, mut bytes) = sample_chain();
        bytes[0] ^= 0x01;
        assert!(scan_bytes(&bytes).is_err());
        assert!(scan_bytes(b"not a transaction log").is_err());
    }

    #[test]
    fn journal_durably_appends_strict_transaction_states() {
        let temp = tempdir().unwrap();
        let wal_path = temp.path().join("transactions.wal");
        let transaction_id;
        {
            let mut journal = WalJournal::open(&wal_path).unwrap();
            transaction_id = journal.begin(br#"{"operation":"enable"}"#).unwrap();
            assert!(journal
                .append(transaction_id, WalState::StepReceipt, b"{}")
                .is_err());
            journal
                .append(transaction_id, WalState::Committing, b"{}")
                .unwrap();
            journal
                .append(transaction_id, WalState::StepReceipt, b"{}")
                .unwrap();
            journal
                .append(transaction_id, WalState::CommittedAfter, b"{}")
                .unwrap();
            journal
                .append(transaction_id, WalState::CleanupComplete, b"{}")
                .unwrap();
        }
        let mut reopened = WalJournal::open(&wal_path).unwrap();
        let second_id = reopened.begin(br#"{"operation":"disable"}"#).unwrap();
        assert_ne!(transaction_id, second_id);
        let ScanOutcome::Clean(records) = scan_bytes(&fs::read(wal_path).unwrap()).unwrap() else {
            panic!("flushed journal should scan cleanly");
        };
        assert_eq!(records.len(), 1);
        assert_eq!(records[0].sequence, 1);
        assert_eq!(records[0].state, WalState::Prepared);
    }

    #[test]
    fn journal_refuses_new_transaction_until_recovery_completes() {
        let temp = tempdir().unwrap();
        let wal_path = temp.path().join("transactions.wal");
        let mut journal = WalJournal::open(&wal_path).unwrap();
        journal.begin(b"{}").unwrap();
        drop(journal);

        let mut reopened = WalJournal::open(&wal_path).unwrap();
        assert!(reopened.begin(b"{}").is_err());
    }

    struct FlushFaultGuard;

    impl Drop for FlushFaultGuard {
        fn drop(&mut self) {
            APPEND_FLUSH_FAULT.with(|fault| fault.set(None));
        }
    }

    fn inject_flush_fault(state: WalState, phase: FlushFaultPhase) -> FlushFaultGuard {
        APPEND_FLUSH_FAULT.with(|fault| fault.set(Some((state, phase))));
        FlushFaultGuard
    }

    #[test]
    fn every_transaction_state_recovers_from_flush_boundary_uncertainty() {
        for state in [
            WalState::Prepared,
            WalState::Committing,
            WalState::StepReceipt,
            WalState::CommittedAfter,
            WalState::AbortedBefore,
            WalState::CleanupComplete,
        ] {
            for phase in [FlushFaultPhase::Before, FlushFaultPhase::After] {
                let temp = tempdir().unwrap();
                let wal_path = temp
                    .path()
                    .join(format!("transactions-{state:?}-{phase:?}.wal"));
                let transaction_id = [0x5a; TRANSACTION_ID_LEN];
                let mut journal = WalJournal::open(&wal_path).unwrap();
                if state != WalState::Prepared {
                    journal
                        .append(transaction_id, WalState::Prepared, b"{}")
                        .unwrap();
                }
                if matches!(
                    state,
                    WalState::StepReceipt
                        | WalState::CommittedAfter
                        | WalState::AbortedBefore
                        | WalState::CleanupComplete
                ) {
                    journal
                        .append(transaction_id, WalState::Committing, b"{}")
                        .unwrap();
                }
                if matches!(state, WalState::CommittedAfter | WalState::CleanupComplete) {
                    journal
                        .append(transaction_id, WalState::StepReceipt, b"{}")
                        .unwrap();
                }
                if state == WalState::CleanupComplete {
                    journal
                        .append(transaction_id, WalState::CommittedAfter, b"{}")
                        .unwrap();
                }

                let guard = inject_flush_fault(state, phase);
                assert!(journal.append(transaction_id, state, b"{}").is_err());
                assert!(journal.append(transaction_id, state, b"{}").is_err());
                drop(journal);
                drop(guard);

                let mut reopened = WalJournal::open(&wal_path).unwrap();
                let incomplete = reopened.incomplete_transaction().unwrap();
                if state == WalState::CleanupComplete {
                    assert!(incomplete.is_none(), "state={state:?}, phase={phase:?}");
                    reopened.begin(b"{}").unwrap();
                } else {
                    assert_eq!(
                        incomplete.unwrap().state,
                        state,
                        "state={state:?}, phase={phase:?}"
                    );
                }
            }
        }
    }
}
