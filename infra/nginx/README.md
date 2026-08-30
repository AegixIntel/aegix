# Local development setup
#
# 1. Start infrastructure:    docker compose up -d redis postgres
# 2. Run migrations:          pnpm --filter @aegix/database migrate
# 3. Start the API:           pnpm --filter @aegix/api dev
# 4. Start the worker:        pnpm --filter @aegix/worker dev
# 5. Start the web app:       pnpm --filter @aegix/web dev
#
# Everything runs against http://localhost.

# Nginx reverse proxy layout (production reference, see architecture.md §99)
server {
    listen 80;
    server_name api.aegix.local;

    location / {
        proxy_pass http://api:3001;
        proxy_set_header Host $host;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Request-Id $request_id;
    }
}
