# Coolify deployment for a Budibase fork

This setup is for deploying a **forked Budibase repo** in Coolify while still keeping the familiar multi-service self-hosted architecture.

## Files

- `hosting/docker-compose.coolify.yaml` - full Coolify-ready stack
- `hosting/coolify/app.Dockerfile` - builds the Budibase app image from repo source
- `hosting/coolify/worker.Dockerfile` - builds the Budibase worker image from repo source
- `coolify.deploy.example.json` - manifest template for the Coolify deploy helper

## Why this exists

The default `hosting/docker-compose.yaml` uses published Budibase images. That is fine for stock Budibase, but it does **not** use changes from your fork.

This Coolify setup builds `app-service` and `worker-service` from the checked-out repo instead, so custom changes in your fork are deployed.

## Recommended git remote layout

Use the Budibase repo itself as your fork checkout.

- `origin` -> your fork
- `upstream` -> `https://github.com/Budibase/budibase.git`

Example after forking:

```bash
git remote rename origin upstream
git remote add origin git@github.com:<you>/budibase.git
git fetch origin
```

## Coolify app shape

- Project: `ITU`
- Environment: `production`
- Server: `Master`
- Domain: `budibase.en1.dk`
- Compose file: `hosting/docker-compose.coolify.yaml`
- Public service/port: `proxy-service:10000`

## Persistent data

Keep these named volumes persisted in Coolify:

- `couchdb3_data`
- `minio_data`
- `redis_data`
- `litellm_data`

The important Budibase state is mainly in CouchDB and MinIO.

## Env handling

Use the production env values from 1Password / Coolify secrets.

The local file path used during preparation is:

```text
hosting/.env.coolify.production
```

Do not commit that file.

## Notes

- This is intended for Coolify repo-based deploys from your fork.
- `proxy-service` is still standard Nginx proxy logic, built locally from `hosting/proxy/Dockerfile`.
- `app-service` and `worker-service` are the parts that matter for Budibase feature customization.
