#!/usr/bin/env python3
"""
Script to update version across multiple files in the project
Usage: 
  python upd.py -v <version>              # Simple version update
  python upd.py -l                        # Full release with changelog
  python upd.py -la                       # Append to existing changelog
Example: 
  python upd.py -v 2.1.3
  python upd.py -l
  python upd.py -la
"""

import sys
import json
import re
from pathlib import Path
from datetime import datetime, timezone


def update_json_file(file_path, version):
    """Update version in a JSON file"""
    try:
        with open(file_path, 'r', encoding='utf-8') as f:
            data = json.load(f)
        
        data['version'] = version
        
        with open(file_path, 'w', encoding='utf-8') as f:
            json.dump(data, f, indent='\t', ensure_ascii=False)
            f.write('\n')  # Add newline at end of file
        
        print(f"✓ Updated {file_path}")
        return True
    except Exception as e:
        print(f"✗ Failed to update {file_path}: {e}")
        return False


def update_cargo_toml(file_path, version):
    """Update version in Cargo.toml"""
    try:
        with open(file_path, 'r', encoding='utf-8') as f:
            content = f.read()
        
        # Replace version in [package] section
        pattern = r'(\[package\][\s\S]*?version\s*=\s*")[^"]*(")'
        replacement = rf'\g<1>{version}\g<2>'
        new_content = re.sub(pattern, replacement, content)
        
        with open(file_path, 'w', encoding='utf-8') as f:
            f.write(new_content)
        
        print(f"✓ Updated {file_path}")
        return True
    except Exception as e:
        print(f"✗ Failed to update {file_path}: {e}")
        return False


def update_consts_ts(file_path, version):
    """Update version in consts.ts"""
    try:
        with open(file_path, 'r', encoding='utf-8') as f:
            content = f.read()
        
        # Replace VERSION constant
        pattern = r'(export\s+const\s+VERSION\s*=\s*")[^"]*(")'
        replacement = rf'\g<1>{version}\g<2>'
        new_content = re.sub(pattern, replacement, content)
        
        with open(file_path, 'w', encoding='utf-8') as f:
            f.write(new_content)
        
        print(f"✓ Updated {file_path}")
        return True
    except Exception as e:
        print(f"✗ Failed to update {file_path}: {e}")
        return False


def get_list_input(prompt):
    """Get list input from user until blank line is entered"""
    items = []
    print(f"{prompt} (press Enter on empty line to finish):")
    while True:
        line = input(f"  [{len(items)}]: ").strip()
        if not line:
            break
        items.append(line)
    return items


def get_rounded_utc_time():
    """Get current UTC time rounded down to nearest 30 minutes"""
    now = datetime.now(timezone.utc)
    # Round down to nearest 30 minutes
    minute = 0 if now.minute < 30 else 30
    rounded = now.replace(minute=minute, second=0, microsecond=0)
    return rounded.strftime("%Y-%m-%dT%H:%M:%SZ")


def append_to_release_data():
    """Append to existing release data in latest.json"""
    print("\n=== Appending to Existing Release ===\n")
    
    root = Path(__file__).parent
    latest_path = root / "latest.json"
    
    # Load existing latest.json
    if not latest_path.exists():
        print(f"Error: {latest_path} not found. Use -l flag to create a new release first.")
        sys.exit(1)
    
    try:
        with open(latest_path, 'r', encoding='utf-8') as f:
            existing_data = json.load(f)
    except Exception as e:
        print(f"Error reading {latest_path}: {e}")
        sys.exit(1)
    
    # Parse existing notes
    try:
        notes_obj = json.loads(existing_data.get('notes', '{}'))
    except Exception as e:
        print(f"Error parsing notes: {e}")
        sys.exit(1)
    
    version = existing_data.get('version', 'unknown')
    print(f"Current version: {version}")
    print(f"Current major changes: {notes_obj.get('major', [])}")
    print(f"Current minor changes: {notes_obj.get('minor', [])}")
    print(f"Current patch changes: {notes_obj.get('patch', [])}")
    
    # Get new changelog items
    print()
    major_changes = get_list_input("Additional Major Changes")
    minor_changes = get_list_input("Additional Minor Changes")
    patch_changes = get_list_input("Additional Patches")
    
    # Append to existing lists
    notes_obj['major'] = notes_obj.get('major', []) + major_changes
    notes_obj['minor'] = notes_obj.get('minor', []) + minor_changes
    notes_obj['patch'] = notes_obj.get('patch', []) + patch_changes
    
    # Update notes in existing data
    existing_data['notes'] = json.dumps(notes_obj, ensure_ascii=False)
    
    # Print summary
    print("\n" + "="*60)
    print("UPDATED SUMMARY:")
    print("="*60)
    print(f"version: {version}")
    print(f"major: {notes_obj['major']}")
    print(f"minor: {notes_obj['minor']}")
    print(f"patch: {notes_obj['patch']}")
    print("="*60)
    
    # Save updated latest.json
    try:
        with open(latest_path, 'w', encoding='utf-8') as f:
            json.dump(existing_data, f, indent='\t', ensure_ascii=False)
            f.write('\n')
        print(f"\n✓ Updated {latest_path}")
    except Exception as e:
        print(f"\n✗ Failed to update {latest_path}: {e}")
        sys.exit(1)
    
    return version


def create_release_data():
    """Create full release data with changelog"""
    print("\n=== Creating Full Release ===\n")
    
    # Get version
    version = input("Version (str): ").strip()
    if not version:
        print("Error: Version is required")
        sys.exit(1)
    
    # Get changelog items
    major_changes = get_list_input("Major Changes")
    minor_changes = get_list_input("Minor Changes")
    patch_changes = get_list_input("Patches")
    
    # Get notice information
    print("\n--- Notice Configuration ---")
    notice_id_input = input("Notice Id (int, leave blank to skip): ").strip()
    
    notice_obj = None
    if notice_id_input:
        try:
            notice_id = int(notice_id_input)
            notice_heading = input("Notice Heading (default: Notice): ").strip() or "Notice"
            notice_subheading = input("Notice Subheading (default: Critical update released, please update IMM): ").strip() or "Critical update released, please update IMM"
            
            ignoreable_input = input("Ignoreable (0, 1 or 2, default 2): ").strip()
            ignoreable = int(ignoreable_input) if ignoreable_input else 2
            
            timer_input = input("Timer (int, default 10): ").strip()
            timer = int(timer_input) if timer_input else 10
            
            notice_obj = {
                "id": notice_id,
                "heading": notice_heading,
                "subheading": notice_subheading,
                "ignoreable": ignoreable,
                "timer": timer,
                "ver": version
            }
        except ValueError as e:
            print(f"Error parsing notice values: {e}")
            sys.exit(1)
    else:
        # Default notice
        notice_obj = {
            "heading": "Test",
            "subheading": "How are you able to see this?",
            "ignoreable": 2,
            "timer": 10,
            "ver": "2.1.1",
            "id": 0
        }
    
    # Check for signature file
    root = Path(__file__).parent
    sig_pattern = f"Integrated Mod Manager (IMM)_{version}_x64-setup.exe.sig"
    print(f"\nChecking for signature file: {sig_pattern}")
    sig_path = root / "src-tauri" / "target" / "release" / "bundle" / "nsis" / sig_pattern
    
    sig = ""
    if sig_path.exists():
        try:
            with open(sig_path, 'r', encoding='utf-8') as f:
                sig = f.read().strip()
            print(f"✓ Found signature file: {sig_pattern}")
        except Exception as e:
            print(f"⚠ Error reading signature file: {e}")
            print("exe sig not found, leaving it blank")
    else:
        print("exe sig not found, leaving it blank")
    
    # Create URL
    url = f"https://github.com/jpbhatt21/integrated-mod-manager/releases/download/v{version}/Integrated.Mod.Manager.IMM._{version}_x64-setup.exe"
    
    # Print summary
    print("\n" + "="*60)
    print("SUMMARY:")
    print("="*60)
    print(f"version: {version}")
    print(f"major: {major_changes}")
    print(f"minor: {minor_changes}")
    print(f"patch: {patch_changes}")
    print(f"noticeId: {notice_obj.get('id', 'N/A')}")
    print(f"noticeHeading: {notice_obj.get('heading', 'N/A')}")
    print(f"noticeSubH: {notice_obj.get('subheading', 'N/A')}")
    print(f"noticeIgnore: {notice_obj.get('ignoreable', 'N/A')}")
    print(f"noticeTimer: {notice_obj.get('timer', 'N/A')}")
    print(f"sig: {'<present>' if sig else '<blank>'}")
    print(f"url: {url}")
    print("="*60)
    
    # Create notes object
    notes_obj = {
        "major": major_changes,
        "minor": minor_changes,
        "patch": patch_changes,
        "notice": notice_obj,
        "cn": {},
        "ru": {},
        "jp": {},
        "kr": {}
    }
    
    # Create latest.json content
    pub_date = get_rounded_utc_time()
    latest_json = {
        "version": version,
        "notes": json.dumps(notes_obj, ensure_ascii=False),
        "pub_date": pub_date,
        "platforms": {
            "windows-x86_64": {
                "signature": sig,
                "url": url
            }
        }
    }
    
    # Save latest.json
    latest_path = root / "latest.json"
    try:
        with open(latest_path, 'w', encoding='utf-8') as f:
            json.dump(latest_json, f, indent='\t', ensure_ascii=False)
            f.write('\n')
        print(f"\n✓ Updated {latest_path}")
    except Exception as e:
        print(f"\n✗ Failed to update {latest_path}: {e}")
        sys.exit(1)
    
    return version


def update_version_files(version):
    """Update version in all standard files"""
    print(f"\nUpdating version to: {version}\n")
    
    # Define all files to update
    root = Path(__file__).parent
    
    files_to_update = [
        ('package.json', 'json'),
        ('src/default.json', 'json'),
        ('src/defaultXX.json', 'json'),
        ('src-tauri/Cargo.toml', 'cargo'),
        ('src-tauri/tauri.conf.json', 'json'),
        ('src/utils/consts.ts', 'consts'),
    ]
    
    success_count = 0
    fail_count = 0
    
    for file_path, file_type in files_to_update:
        full_path = root / file_path
        
        if not full_path.exists():
            print(f"⚠ File not found: {file_path}")
            fail_count += 1
            continue
        
        if file_type == 'json':
            if update_json_file(full_path, version):
                success_count += 1
            else:
                fail_count += 1
        elif file_type == 'cargo':
            if update_cargo_toml(full_path, version):
                success_count += 1
            else:
                fail_count += 1
        elif file_type == 'consts':
            if update_consts_ts(full_path, version):
                success_count += 1
            else:
                fail_count += 1
    
    print(f"\n{'='*50}")
    print(f"Summary: {success_count} files updated, {fail_count} files failed")
    print(f"{'='*50}")
    
    return fail_count == 0


def main():
    if len(sys.argv) < 2:
        print("Usage:")
        print("  python upd.py -v <version>    # Simple version update")
        print("  python upd.py -l              # Full release with changelog")
        print("  python upd.py -la             # Append to existing changelog")
        print("\nExamples:")
        print("  python upd.py -v 2.1.3")
        print("  python upd.py -l")
        print("  python upd.py -la")
        sys.exit(1)
    
    flag = sys.argv[1]
    
    if flag == "-v":
        # Simple version update
        if len(sys.argv) != 3:
            print("Error: -v flag requires a version argument")
            print("Usage: python upd.py -v <version>")
            sys.exit(1)
        
        version = sys.argv[2]
        
        # Validate version format (basic check)
        if not re.match(r'^\d+\.\d+\.\d+(-[\w\.]+)?$', version):
            print(f"Warning: Version '{version}' doesn't follow semantic versioning (x.y.z)")
            response = input("Continue anyway? (y/n): ")
            if response.lower() != 'y':
                sys.exit(1)
        
        # Update version in all standard files
        success = update_version_files(version)
        
        # Also update latest.json with just the version
        root = Path(__file__).parent
        latest_path = root / "latest.json"
        if latest_path.exists():
            try:
                with open(latest_path, 'r', encoding='utf-8') as f:
                    data = json.load(f)
                data['version'] = version
                
                # Check for signature file
                sig_pattern = f"Integrated Mod Manager (IMM)_{version}_x64-setup.exe.sig"
                print(f"\nChecking for signature file: {sig_pattern}")
                sig_path = root / "src-tauri" / "target" / "release" / "bundle" / "nsis" / sig_pattern
                
                sig = ""
                if sig_path.exists():
                    try:
                        with open(sig_path, 'r', encoding='utf-8') as f:
                            sig = f.read().strip()
                        print(f"✓ Found signature file: {sig_pattern}")
                    except Exception as e:
                        print(f"⚠ Error reading signature file: {e}")
                        print("exe sig not found, leaving it blank")
                else:
                    print("exe sig not found, leaving it blank")
                
                # Update signature and URL in platforms
                url = f"https://github.com/jpbhatt21/integrated-mod-manager/releases/download/v{version}/Integrated.Mod.Manager.IMM._{version}_x64-setup.exe"
                if 'platforms' in data and 'windows-x86_64' in data['platforms']:
                    data['platforms']['windows-x86_64']['signature'] = sig
                    data['platforms']['windows-x86_64']['url'] = url
                
                with open(latest_path, 'w', encoding='utf-8') as f:
                    json.dump(data, f, indent='\t', ensure_ascii=False)
                    f.write('\n')
                print(f"✓ Updated {latest_path}")
            except Exception as e:
                print(f"✗ Failed to update {latest_path}: {e}")
                success = False
        
        sys.exit(0 if success else 1)
    
    elif flag == "-l":
        # Full release with changelog
        version = create_release_data()
        
        # # Update version in all other files
        # success = update_version_files(version)
        
        sys.exit(0)
    elif flag == "-la":
        # Append to existing changelog
        version = append_to_release_data()
        
        sys.exit(0)
    else:
        print(f"Error: Unknown flag '{flag}'")
        print("Use -v for version update or -l for full release")
        sys.exit(1)


if __name__ == "__main__":
    main()
