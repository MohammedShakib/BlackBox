use actix_cors::Cors;
use actix_web::{get, head, post, web, App, HttpRequest, HttpResponse, HttpServer, Responder};
use async_stream::stream;
use grammers_client::types::{LoginToken, Media, PasswordToken, Peer};
use grammers_client::{Client, SignInError};
use grammers_mtsender::SenderPool;
use grammers_session::storages::SqliteSession;
use grammers_tl_types as tl;
use rand::Rng;
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::env;
use std::path::PathBuf;
use std::sync::Arc;
use tokio::sync::{Mutex, RwLock};

const TELEGRAM_CHUNK_SIZE: i32 = 512 * 1024;

#[derive(Clone)]
struct AppState {
    client: Arc<Mutex<Option<Client>>>,
    login_token: Arc<Mutex<Option<LoginToken>>>,
    password_token: Arc<Mutex<Option<PasswordToken>>>,
    api_id: Arc<Mutex<Option<i32>>>,
    peer_cache: Arc<RwLock<HashMap<i64, Peer>>>,
    session_path: String,
    api_key: String,
}

#[derive(Serialize)]
struct HealthResponse {
    status: String,
    version: String,
}

#[derive(Serialize)]
struct AuthResult {
    success: bool,
    next_step: Option<String>,
    error: Option<String>,
}

#[derive(Serialize)]
struct AuthStatusResponse {
    connected: bool,
    authorized: bool,
}

#[derive(Deserialize)]
struct RequestCodeBody {
    phone: String,
    api_id: i32,
    api_hash: String,
}

#[derive(Deserialize)]
struct SignInBody {
    code: String,
}

#[derive(Deserialize)]
struct PasswordBody {
    password: String,
}

#[derive(Serialize)]
struct ErrorBody {
    error: ErrorDetail,
}

#[derive(Serialize)]
struct ErrorDetail {
    code: String,
    message: String,
}

#[derive(Deserialize)]
struct FilesQuery {
    folder_id: Option<i64>,
    page: Option<u32>,
    limit: Option<u32>,
    search: Option<String>,
}

#[derive(Serialize)]
struct FilesResponse {
    files: Vec<ApiFile>,
    page: u32,
    limit: u32,
    total: usize,
}

#[derive(Serialize)]
struct ApiFile {
    id: i64,
    folder_id: Option<i64>,
    name: String,
    size: u64,
    mime_type: Option<String>,
    created_at: String,
}

#[derive(Deserialize)]
struct FolderQuery {
    folder_id: Option<i64>,
}

fn json_error(code: &str, message: &str, status: u16) -> HttpResponse {
    let body = ErrorBody {
        error: ErrorDetail {
            code: code.to_string(),
            message: message.to_string(),
        },
    };
    HttpResponse::build(actix_web::http::StatusCode::from_u16(status).unwrap()).json(body)
}

fn map_error(e: impl std::fmt::Display) -> String {
    let err_str = e.to_string();
    if err_str.contains("FLOOD_WAIT") {
        if let Some(start) = err_str.find("(value: ") {
            let rest = &err_str[start + 8..];
            if let Some(end) = rest.find(')') {
                if let Ok(seconds) = rest[..end].parse::<i64>() {
                    return format!("FLOOD_WAIT_{}", seconds);
                }
            }
        }
        return "FLOOD_WAIT_60".to_string();
    }
    err_str
}

fn check_auth(req: &HttpRequest, state: &web::Data<AppState>) -> Result<(), HttpResponse> {
    let provided = req.headers().get("X-API-Key").and_then(|v| v.to_str().ok());
    match provided {
        Some(key) if key == state.api_key => Ok(()),
        Some(_) => Err(json_error("UNAUTHORIZED", "Invalid API key", 401)),
        None => Err(json_error("UNAUTHORIZED", "Missing X-API-Key header", 401)),
    }
}

async fn resolve_peer(
    client: &Client,
    folder_id: Option<i64>,
    peer_cache: &Arc<RwLock<HashMap<i64, Peer>>>,
) -> Result<Peer, String> {
    if let Some(fid) = folder_id {
        {
            let cache = peer_cache.read().await;
            if let Some(peer) = cache.get(&fid) {
                return Ok(peer.clone());
            }
        }

        let mut found: Option<Peer> = None;
        let mut dialogs = client.iter_dialogs();
        let mut cache = peer_cache.write().await;
        while let Some(dialog) = dialogs.next().await.map_err(|e| e.to_string())? {
            let peer_id = match &dialog.peer {
                Peer::Channel(c) => Some(c.raw.id),
                Peer::User(u) => Some(u.raw.id()),
                _ => None,
            };
            if let Some(id) = peer_id {
                cache.insert(id, dialog.peer.clone());
                if id == fid {
                    found = Some(dialog.peer.clone());
                }
            }
        }

        found.ok_or_else(|| format!("Folder/Chat {} not found", fid))
    } else {
        match client.get_me().await {
            Ok(me) => Ok(Peer::User(me)),
            Err(e) => Err(e.to_string()),
        }
    }
}

async fn ensure_client_initialized(state: &AppState, api_id: i32) -> Result<Client, String> {
    let mut client_guard = state.client.lock().await;
    if let Some(client) = client_guard.as_ref() {
        return Ok(client.clone());
    }

    let session = match SqliteSession::open(&state.session_path).map_err(|e| e.to_string()) {
        Ok(s) => s,
        Err(_) => {
            let _ = std::fs::remove_file(&state.session_path);
            let _ = std::fs::remove_file(format!("{}-wal", state.session_path));
            let _ = std::fs::remove_file(format!("{}-shm", state.session_path));
            SqliteSession::open(&state.session_path)
                .map_err(|e| format!("Failed to open session after recreation: {}", e))?
        }
    };

    let pool = SenderPool::new(Arc::new(session), api_id);
    let client = Client::new(&pool);
    let SenderPool { runner, .. } = pool;

    tokio::spawn(async move {
        runner.run().await;
        log::warn!("Telegram runner exited");
    });

    *client_guard = Some(client.clone());
    *state.api_id.lock().await = Some(api_id);
    Ok(client)
}

fn parse_range_header(range: &str, total_size: u64) -> Option<(u64, u64)> {
    let range = range.trim().strip_prefix("bytes=")?;
    let parts: Vec<&str> = range.split('-').collect();
    if parts.len() != 2 {
        return None;
    }

    let start = if parts[0].is_empty() {
        let suffix: u64 = parts[1].parse().ok()?;
        total_size.saturating_sub(suffix)
    } else {
        parts[0].parse::<u64>().ok()?
    };

    let end = if parts[1].is_empty() {
        total_size - 1
    } else {
        parts[1].parse::<u64>().ok()?.min(total_size - 1)
    };

    if start > end || start >= total_size {
        return None;
    }

    Some((start, end))
}

#[get("/api/v1/health")]
async fn api_health() -> impl Responder {
    HttpResponse::Ok().json(HealthResponse {
        status: "ok".to_string(),
        version: env!("CARGO_PKG_VERSION").to_string(),
    })
}

#[get("/api/v1/auth/status")]
async fn api_auth_status(state: web::Data<AppState>) -> impl Responder {
    let client_opt = { state.client.lock().await.clone() };
    if let Some(client) = client_opt {
        let authorized = client.is_authorized().await.unwrap_or(false);
        HttpResponse::Ok().json(AuthStatusResponse {
            connected: true,
            authorized,
        })
    } else {
        HttpResponse::Ok().json(AuthStatusResponse {
            connected: false,
            authorized: false,
        })
    }
}

#[post("/api/v1/auth/request_code")]
async fn api_auth_request_code(
    body: web::Json<RequestCodeBody>,
    state: web::Data<AppState>,
) -> impl Responder {
    if body.api_hash.trim().is_empty() {
        return HttpResponse::BadRequest().json(AuthResult {
            success: false,
            next_step: None,
            error: Some("API hash cannot be empty".to_string()),
        });
    }

    let client = match ensure_client_initialized(&state, body.api_id).await {
        Ok(c) => c,
        Err(e) => {
            return HttpResponse::InternalServerError().json(AuthResult {
                success: false,
                next_step: None,
                error: Some(e),
            })
        }
    };

    match client.request_login_code(&body.phone, &body.api_hash).await {
        Ok(token) => {
            *state.login_token.lock().await = Some(token);
            HttpResponse::Ok().json(AuthResult {
                success: true,
                next_step: Some("code".to_string()),
                error: None,
            })
        }
        Err(e) => HttpResponse::BadRequest().json(AuthResult {
            success: false,
            next_step: None,
            error: Some(map_error(e)),
        }),
    }
}

#[post("/api/v1/auth/sign_in")]
async fn api_auth_sign_in(body: web::Json<SignInBody>, state: web::Data<AppState>) -> impl Responder {
    let client_opt = { state.client.lock().await.clone() };
    let client = match client_opt {
        Some(c) => c,
        None => {
            return HttpResponse::BadRequest().json(AuthResult {
                success: false,
                next_step: None,
                error: Some("Client not initialized".to_string()),
            })
        }
    };

    let token_guard = state.login_token.lock().await;
    let token = match token_guard.as_ref() {
        Some(t) => t,
        None => {
            return HttpResponse::BadRequest().json(AuthResult {
                success: false,
                next_step: None,
                error: Some("No login session found".to_string()),
            })
        }
    };

    let result = client.sign_in(token, &body.code).await;
    drop(token_guard);

    match result {
        Ok(_) => {
            *state.login_token.lock().await = None;
            HttpResponse::Ok().json(AuthResult {
                success: true,
                next_step: Some("dashboard".to_string()),
                error: None,
            })
        }
        Err(SignInError::PasswordRequired(pw_token)) => {
            *state.password_token.lock().await = Some(pw_token);
            HttpResponse::Ok().json(AuthResult {
                success: true,
                next_step: Some("password".to_string()),
                error: None,
            })
        }
        Err(SignInError::InvalidCode) => HttpResponse::BadRequest().json(AuthResult {
            success: false,
            next_step: Some("code".to_string()),
            error: Some("Invalid verification code".to_string()),
        }),
        Err(SignInError::SignUpRequired { .. }) => HttpResponse::BadRequest().json(AuthResult {
            success: false,
            next_step: None,
            error: Some("Sign-up required for this account".to_string()),
        }),
        Err(SignInError::InvalidPassword) => HttpResponse::BadRequest().json(AuthResult {
            success: false,
            next_step: Some("password".to_string()),
            error: Some("Invalid password".to_string()),
        }),
        Err(SignInError::Other(e)) => HttpResponse::BadRequest().json(AuthResult {
            success: false,
            next_step: None,
            error: Some(map_error(e)),
        }),
    }
}

#[post("/api/v1/auth/check_password")]
async fn api_auth_check_password(
    body: web::Json<PasswordBody>,
    state: web::Data<AppState>,
) -> impl Responder {
    let client_opt = { state.client.lock().await.clone() };
    let client = match client_opt {
        Some(c) => c,
        None => {
            return HttpResponse::BadRequest().json(AuthResult {
                success: false,
                next_step: None,
                error: Some("Client not initialized".to_string()),
            })
        }
    };

    let pw_opt = { state.password_token.lock().await.take() };
    let pw_token = match pw_opt {
        Some(p) => p,
        None => {
            return HttpResponse::BadRequest().json(AuthResult {
                success: false,
                next_step: Some("password".to_string()),
                error: Some("No password session found".to_string()),
            })
        }
    };

    match client.check_password(pw_token, body.password.as_bytes()).await {
        Ok(_) => HttpResponse::Ok().json(AuthResult {
            success: true,
            next_step: Some("dashboard".to_string()),
            error: None,
        }),
        Err(SignInError::InvalidPassword) => HttpResponse::BadRequest().json(AuthResult {
            success: false,
            next_step: Some("password".to_string()),
            error: Some("Invalid password".to_string()),
        }),
        Err(e) => HttpResponse::BadRequest().json(AuthResult {
            success: false,
            next_step: Some("password".to_string()),
            error: Some(map_error(e)),
        }),
    }
}

#[get("/api/v1/files")]
async fn api_list_files(
    req: HttpRequest,
    query: web::Query<FilesQuery>,
    state: web::Data<AppState>,
) -> impl Responder {
    if let Err(e) = check_auth(&req, &state) {
        return e;
    }

    let client_opt = { state.client.lock().await.clone() };
    let client = match client_opt {
        Some(c) => c,
        None => return json_error("NOT_CONNECTED", "Telegram client is not connected", 503),
    };

    let peer = match resolve_peer(&client, query.folder_id, &state.peer_cache).await {
        Ok(p) => p,
        Err(e) => return json_error("PEER_ERROR", &e, 400),
    };

    let mut all_files: Vec<ApiFile> = Vec::new();
    let mut msgs = client.iter_messages(&peer);

    while let Some(msg) = msgs.next().await.ok().flatten() {
        if let Some(doc) = msg.media() {
            let (name, size, mime) = match doc {
                Media::Document(d) => (d.name().to_string(), d.size(), d.mime_type().map(|s| s.to_string())),
                Media::Photo(_) => ("Photo.jpg".to_string(), 0, Some("image/jpeg".to_string())),
                _ => ("Unknown".to_string(), 0, None),
            };

            if let Some(ref search) = query.search {
                if !name.to_lowercase().contains(&search.to_lowercase()) {
                    continue;
                }
            }

            all_files.push(ApiFile {
                id: msg.id() as i64,
                folder_id: query.folder_id,
                name,
                size: size as u64,
                mime_type: mime,
                created_at: msg.date().to_string(),
            });
        }
    }

    let total = all_files.len();
    let page = query.page.unwrap_or(1).max(1);
    let limit = query.limit.unwrap_or(50).clamp(1, 200);
    let start = ((page - 1) * limit) as usize;
    let paginated: Vec<ApiFile> = all_files.into_iter().skip(start).take(limit as usize).collect();

    HttpResponse::Ok().json(FilesResponse {
        files: paginated,
        page,
        limit,
        total,
    })
}

#[get("/api/v1/files/{message_id}")]
async fn api_get_file(
    req: HttpRequest,
    path: web::Path<i64>,
    query: web::Query<FolderQuery>,
    state: web::Data<AppState>,
) -> impl Responder {
    if let Err(e) = check_auth(&req, &state) {
        return e;
    }

    let message_id = path.into_inner() as i32;
    let client_opt = { state.client.lock().await.clone() };
    let client = match client_opt {
        Some(c) => c,
        None => return json_error("NOT_CONNECTED", "Telegram client is not connected", 503),
    };

    let peer = match resolve_peer(&client, query.folder_id, &state.peer_cache).await {
        Ok(p) => p,
        Err(e) => return json_error("PEER_ERROR", &e, 400),
    };

    match client.get_messages_by_id(peer, &[message_id]).await {
        Ok(messages) => {
            if let Some(Some(msg)) = messages.first() {
                if let Some(doc) = msg.media() {
                    let (name, size, mime) = match doc {
                        Media::Document(d) => (d.name().to_string(), d.size(), d.mime_type().map(|s| s.to_string())),
                        Media::Photo(_) => ("Photo.jpg".to_string(), 0, Some("image/jpeg".to_string())),
                        _ => ("Unknown".to_string(), 0, None),
                    };
                    return HttpResponse::Ok().json(ApiFile {
                        id: msg.id() as i64,
                        folder_id: query.folder_id,
                        name,
                        size: size as u64,
                        mime_type: mime,
                        created_at: msg.date().to_string(),
                    });
                }
            }
            json_error("NOT_FOUND", "File not found", 404)
        }
        Err(e) => json_error("FETCH_ERROR", &format!("Failed to fetch file: {}", e), 500),
    }
}

#[head("/api/v1/files/{message_id}/download")]
async fn api_download_file_head(
    req: HttpRequest,
    path: web::Path<i64>,
    query: web::Query<FolderQuery>,
    state: web::Data<AppState>,
) -> impl Responder {
    if let Err(e) = check_auth(&req, &state) {
        return e;
    }

    let message_id = path.into_inner() as i32;
    let client_opt = { state.client.lock().await.clone() };
    let client = match client_opt {
        Some(c) => c,
        None => return json_error("NOT_CONNECTED", "Telegram client is not connected", 503),
    };

    let peer = match resolve_peer(&client, query.folder_id, &state.peer_cache).await {
        Ok(p) => p,
        Err(e) => return json_error("PEER_ERROR", &e, 400),
    };

    match client.get_messages_by_id(peer, &[message_id]).await {
        Ok(messages) => {
            if let Some(Some(msg)) = messages.first() {
                if let Some(media) = msg.media() {
                    let size = match &media {
                        Media::Document(d) => d.size() as u64,
                        _ => 0,
                    };
                    let mime = match &media {
                        Media::Document(d) => d.mime_type().unwrap_or("application/octet-stream").to_string(),
                        _ => "application/octet-stream".to_string(),
                    };
                    return HttpResponse::Ok()
                        .insert_header(("Content-Type", mime))
                        .insert_header(("Content-Length", size.to_string()))
                        .insert_header(("Accept-Ranges", "bytes"))
                        .finish();
                }
            }
            json_error("NOT_FOUND", "File not found", 404)
        }
        Err(e) => json_error("FETCH_ERROR", &format!("Failed to fetch file: {}", e), 500),
    }
}

#[get("/api/v1/files/{message_id}/download")]
async fn api_download_file(
    req: HttpRequest,
    path: web::Path<i64>,
    query: web::Query<FolderQuery>,
    state: web::Data<AppState>,
) -> impl Responder {
    if let Err(e) = check_auth(&req, &state) {
        return e;
    }

    let message_id = path.into_inner() as i32;
    let client_opt = { state.client.lock().await.clone() };
    let client = match client_opt {
        Some(c) => c,
        None => return json_error("NOT_CONNECTED", "Telegram client is not connected", 503),
    };

    let peer = match resolve_peer(&client, query.folder_id, &state.peer_cache).await {
        Ok(p) => p,
        Err(e) => return json_error("PEER_ERROR", &e, 400),
    };

    match client.get_messages_by_id(peer, &[message_id]).await {
        Ok(messages) => {
            if let Some(Some(msg)) = messages.first() {
                if let Some(media) = msg.media() {
                    let size = match &msg.raw {
                        tl::enums::Message::Message(m) => match &m.media {
                            Some(tl::enums::MessageMedia::Document(md)) => md
                                .document
                                .as_ref()
                                .and_then(|d| match d {
                                    tl::enums::Document::Document(doc) => Some(doc.size as u64),
                                    _ => None,
                                })
                                .unwrap_or(0),
                            _ => 0,
                        },
                        _ => 0,
                    };

                    let mime = match &media {
                        Media::Document(d) => d
                            .mime_type()
                            .unwrap_or("application/octet-stream")
                            .to_string(),
                        Media::Photo(_) => "image/jpeg".to_string(),
                        _ => "application/octet-stream".to_string(),
                    };

                    let filename = match &media {
                        Media::Document(d) => d.name().to_string(),
                        Media::Photo(_) => "Photo.jpg".to_string(),
                        _ => "download".to_string(),
                    };

                    let range_header = req.headers().get("Range").and_then(|v| v.to_str().ok());

                    let (start_byte, end_byte, is_partial) = if let Some(range_str) = range_header {
                        match parse_range_header(range_str, size) {
                            Some((start, end)) => (start, end, true),
                            None => {
                                return HttpResponse::build(actix_web::http::StatusCode::RANGE_NOT_SATISFIABLE)
                                    .insert_header(("Content-Range", format!("bytes */{}", size)))
                                    .body("Invalid Range header");
                            }
                        }
                    } else {
                        (0, size.saturating_sub(1), false)
                    };

                    let content_length = end_byte - start_byte + 1;
                    let chunks_to_skip = (start_byte / TELEGRAM_CHUNK_SIZE as u64) as i32;
                    let bytes_to_discard = start_byte % TELEGRAM_CHUNK_SIZE as u64;

                    let download_iter = client
                        .iter_download(&media)
                        .chunk_size(TELEGRAM_CHUNK_SIZE)
                        .skip_chunks(chunks_to_skip);

                    let stream = stream! {
                        let mut bytes_sent: u64 = 0;
                        let mut first_chunk = true;
                        let mut iter = download_iter;

                        while let Some(chunk) = iter.next().await.transpose() {
                            match chunk {
                                Ok(bytes) => {
                                    let remaining = content_length - bytes_sent;
                                    if remaining == 0 {
                                        break;
                                    }

                                    let mut data = bytes;
                                    if first_chunk && bytes_to_discard > 0 {
                                        let discard = bytes_to_discard.min(data.len() as u64) as usize;
                                        data = data[discard..].to_vec();
                                        first_chunk = false;
                                    }

                                    if data.len() as u64 > remaining {
                                        yield Ok::<_, actix_web::Error>(web::Bytes::from(data[..remaining as usize].to_vec()));
                                        break;
                                    }

                                    bytes_sent += data.len() as u64;
                                    yield Ok::<_, actix_web::Error>(web::Bytes::from(data));
                                }
                                Err(e) => {
                                    log::error!("API download stream error: {}", e);
                                    break;
                                }
                            }
                        }
                    };

                    if is_partial {
                        return HttpResponse::PartialContent()
                            .insert_header(("Content-Type", mime))
                            .insert_header(("Content-Length", content_length.to_string()))
                            .insert_header(("Content-Range", format!("bytes {}-{}/{}", start_byte, end_byte, size)))
                            .insert_header(("Accept-Ranges", "bytes"))
                            .insert_header(("Content-Disposition", format!("attachment; filename=\"{}\"", filename)))
                            .streaming(stream);
                    }

                    return HttpResponse::Ok()
                        .insert_header(("Content-Type", mime))
                        .insert_header(("Content-Length", size.to_string()))
                        .insert_header(("Content-Disposition", format!("attachment; filename=\"{}\"", filename)))
                        .insert_header(("Accept-Ranges", "bytes"))
                        .streaming(stream);
                }
            }
            json_error("NOT_FOUND", "File not found", 404)
        }
        Err(e) => json_error("FETCH_ERROR", &format!("Failed to fetch file: {}", e), 500),
    }
}

#[actix_web::main]
async fn main() -> std::io::Result<()> {
    env_logger::Builder::from_env(env_logger::Env::default().default_filter_or("info")).init();

    let host = env::var("HOST").unwrap_or_else(|_| "0.0.0.0".to_string());
    let port: u16 = env::var("PORT")
        .ok()
        .and_then(|v| v.parse::<u16>().ok())
        .unwrap_or(8550);

    let session_dir = env::var("SESSION_DIR").unwrap_or_else(|_| "./data".to_string());
    let session_path = {
        let path = PathBuf::from(&session_dir);
        if !path.exists() {
            std::fs::create_dir_all(&path)?;
        }
        path.join("telegram.session").to_string_lossy().to_string()
    };

    let api_key = env::var("API_KEY").unwrap_or_else(|_| {
        let bytes: Vec<u8> = (0..16).map(|_| rand::thread_rng().gen::<u8>()).collect();
        let generated: String = bytes.iter().map(|b| format!("{:02x}", b)).collect();
        log::warn!("API_KEY not set. Generated temporary key for this boot: {}", generated);
        generated
    });

    let state = AppState {
        client: Arc::new(Mutex::new(None)),
        login_token: Arc::new(Mutex::new(None)),
        password_token: Arc::new(Mutex::new(None)),
        api_id: Arc::new(Mutex::new(None)),
        peer_cache: Arc::new(RwLock::new(HashMap::new())),
        session_path,
        api_key,
    };

    log::info!("Starting BlackBox backend on http://{}:{}", host, port);

    HttpServer::new(move || {
        let cors = Cors::default()
            .allow_any_origin()
            .allow_any_method()
            .allow_any_header()
            .expose_headers(["Content-Range", "Content-Length", "Accept-Ranges"])
            .max_age(3600);

        App::new()
            .wrap(cors)
            .app_data(web::Data::new(state.clone()))
            .service(api_health)
            .service(api_auth_status)
            .service(api_auth_request_code)
            .service(api_auth_sign_in)
            .service(api_auth_check_password)
            .service(api_list_files)
            .service(api_get_file)
            .service(api_download_file)
            .service(api_download_file_head)
    })
    .bind((host, port))?
    .run()
    .await
}
