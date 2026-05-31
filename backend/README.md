# BlackBox Backend (Render-ready)

This is a server-only Rust backend for web mode. It does not depend on Tauri or desktop UI libraries.

## Required Environment Variables

- `API_KEY`: API key expected in `X-API-Key` header for file endpoints.

## Optional Environment Variables

- `HOST` (default: `0.0.0.0`)
- `PORT` (default: `8550`)
- `SESSION_DIR` (default: `./data`)

## Endpoints

Public (no API key):
- `GET /api/v1/health`
- `GET /api/v1/auth/status`
- `POST /api/v1/auth/request_code`
- `POST /api/v1/auth/sign_in`
- `POST /api/v1/auth/check_password`

Protected (`X-API-Key` required):
- `GET /api/v1/files`
- `GET /api/v1/files/{id}`
- `HEAD /api/v1/files/{id}/download`
- `GET /api/v1/files/{id}/download`

## Auth Flow (Telegram)

1. `POST /api/v1/auth/request_code`
2. `POST /api/v1/auth/sign_in`
3. If needed, `POST /api/v1/auth/check_password`

## Example: Request Code

```bash
curl -X POST "$BASE/api/v1/auth/request_code" \
  -H "Content-Type: application/json" \
  -d '{"phone":"+8801XXXXXXXXX","api_id":123456,"api_hash":"YOUR_API_HASH"}'
```

## Example: List Files

```bash
curl -H "X-API-Key: $API_KEY" "$BASE/api/v1/files?limit=10"
```
