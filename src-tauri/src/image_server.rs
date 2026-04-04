use once_cell::sync::Lazy;
use std::convert::Infallible;
use std::fs;
use std::path::Path;
use tauri_plugin_tracing::tracing;
use urlencoding::decode;
use warp::http::StatusCode;
use warp::{Filter, Rejection, Reply};

static SUPPORTED_EXTENSIONS: &[&str] = &["png", "jpg", "jpeg", "webp", "gif", "bmp", "tiff"];

static CACHE_HEADERS: Lazy<Vec<(&'static str, &'static str)>> = Lazy::new(|| {
    vec![
        ("Cache-Control", "public, max-age=3600"),
        ("X-Content-Type-Options", "nosniff"),
    ]
});

#[derive(serde::Serialize)]
struct ErrorResponse {
    status: &'static str,
    message: String,
}

impl ErrorResponse {
    fn new(message: String) -> Self {
        Self {
            status: "error",
            message,
        }
    }
}

#[derive(serde::Serialize)]
struct HealthResponse {
    status: &'static str,
    service: &'static str,
}

impl HealthResponse {
    fn new() -> Self {
        Self {
            status: "healthy",
            service: "wwmm-image-server",
        }
    }
}

async fn handle_rejection(err: Rejection) -> Result<impl Reply, Infallible> {
    let (code, message) = if err.is_not_found() {
        (StatusCode::NOT_FOUND, "Endpoint not found".to_string())
    } else if let Some(_) = err.find::<warp::filters::body::BodyDeserializeError>() {
        (StatusCode::BAD_REQUEST, "Invalid request body".to_string())
    } else {
        log::error!("Unhandled rejection: {:?}", err);
        (
            StatusCode::INTERNAL_SERVER_ERROR,
            "Internal server error".to_string(),
        )
    };

    let error_response = ErrorResponse::new(message);
    let json = warp::reply::json(&error_response);
    Ok(warp::reply::with_status(json, code))
}

async fn handle_preview_image(subpath: String) -> Result<impl Reply, Rejection> {
    tracing::info!("Preview image request for: {}", subpath);

    let decoded_path = decode(&subpath)
        .map(|cow_str| cow_str.into_owned())
        .unwrap_or_else(|_| String::from(""));
    let directory = Path::new(&decoded_path);

    if !directory.exists() {
        let error = ErrorResponse::new("Directory does not exist".to_string());
        return Ok(
            warp::reply::with_status(warp::reply::json(&error), StatusCode::NOT_FOUND)
                .into_response(),
        );
    }

    if !directory.is_dir() {
        let error = ErrorResponse::new("Path is not a directory".to_string());
        return Ok(
            warp::reply::with_status(warp::reply::json(&error), StatusCode::BAD_REQUEST)
                .into_response(),
        );
    }

    for ext in SUPPORTED_EXTENSIONS {
        let preview_file = directory.join(format!("preview.{}", ext));

        if preview_file.exists() && preview_file.is_file() {
            match serve_image_file(&preview_file).await {
                Ok(response) => return Ok(response),
                Err(e) => {
                    tracing::error!("Error serving file {:?}: {}", preview_file, e);
                    continue;
                }
            }
        }
    }

    let error = ErrorResponse::new(format!(
        "No preview file found in directory. Supported formats: {}",
        SUPPORTED_EXTENSIONS.join(", ")
    ));

    Ok(warp::reply::with_status(warp::reply::json(&error), StatusCode::NOT_FOUND).into_response())
}

async fn serve_image_file(
    file_path: &Path,
) -> Result<warp::reply::Response, Box<dyn std::error::Error>> {
    let file_contents = fs::read(file_path)?;

    let mime_type = mime_guess::from_path(file_path)
        .first_or_octet_stream()
        .to_string();

    let mut response = warp::reply::Response::new(file_contents.into());

    response
        .headers_mut()
        .insert("content-type", mime_type.parse().unwrap());

    for (key, value) in CACHE_HEADERS.iter() {
        response.headers_mut().insert(*key, value.parse().unwrap());
    }

    Ok(response)
}

async fn handle_health_check() -> Result<impl Reply, Rejection> {
    let health_response = HealthResponse::new();
    Ok(warp::reply::json(&health_response))
}

pub fn create_routes() -> impl Filter<Extract = impl Reply, Error = Infallible> + Clone {
    let cors = warp::cors()
        .allow_origins(vec!["http://localhost:1420", "tauri://localhost"])
        .allow_headers(vec!["content-type"])
        .allow_methods(vec!["GET"]);

    let preview_route = warp::path("preview")
        .and(warp::path::tail())
        .and(warp::get())
        .map(|tail: warp::path::Tail| tail.as_str().to_string())
        .and_then(handle_preview_image);

    let health_route = warp::path("health")
        .and(warp::get())
        .and_then(handle_health_check);

    preview_route
        .or(health_route)
        .with(cors)
        .recover(handle_rejection)
}

pub async fn start_image_server(port: u16) -> Result<(), Box<dyn std::error::Error>> {
    tracing::info!("Starting WWMM Image Server on 127.0.0.1:{}", port);

    let routes = create_routes();

    warp::serve(routes).run(([127, 0, 0, 1], port)).await;

    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;
    use tempfile::TempDir;

    #[tokio::test]
    async fn test_health_check() {
        let routes = create_routes();

        let response = warp::test::request()
            .method("GET")
            .path("/health")
            .reply(&routes)
            .await;

        assert_eq!(response.status(), 200);
    }

    #[tokio::test]
    async fn test_preview_image_not_found() {
        let routes = create_routes();

        let response = warp::test::request()
            .method("GET")
            .path("/preview/nonexistent/path")
            .reply(&routes)
            .await;

        assert_eq!(response.status(), 404);
    }

    #[tokio::test]
    async fn test_preview_image_success() {
        let temp_dir = TempDir::new().unwrap();
        let preview_path = temp_dir.path().join("preview.png");
        fs::write(&preview_path, b"fake png data").unwrap();

        let routes = create_routes();
        let path_str = temp_dir.path().to_str().unwrap();

        let response = warp::test::request()
            .method("GET")
            .path(&format!("/preview/{}", path_str))
            .reply(&routes)
            .await;

        assert_eq!(response.status(), 200);
    }
}
