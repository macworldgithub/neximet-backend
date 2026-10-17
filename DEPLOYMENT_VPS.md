# Neximet VPS deployment with PM2 and Nginx

Prepared for **Ubuntu 24.04 LTS**, Node.js **22.x**, one backend process and one frontend process. A 2-vCPU/4-GB VPS is a practical starting point when MongoDB is hosted separately; frontend builds also need free memory and disk space. Use current security patches of Node 22 and your OS packages.

| Public hostname | Destination |
| --- | --- |
| `backend.neximet.com` | Express/Socket.IO on `127.0.0.1:4052` |
| `www.backend.neximet.com` | Same backend, served directly |
| `portal.neximet.com` | Next.js on `127.0.0.1:4051` |
| `www.portal.neximet.com` | HTTPS 308 redirect to `portal.neximet.com` |

## Quick Automated Deployment (Recommended)

All services can be deployed with a single command using `deploy.sh`:

```bash
# Clone or copy repository to VPS, then run:
cd /var/www/neximet
sudo bash deploy.sh --email your-email@neximet.com
```

This single command will:
1. Verify Node.js, PM2, Nginx, and Certbot
2. Setup and build `/var/www/neximet/backend` on **port 4052**
3. Setup and build `/var/www/neximet/frontend` on **port 4051**
4. Configure Nginx reverse proxy with SSL (`portal.neximet.com` & `backend.neximet.com`)
5. Request/configure Let's Encrypt certificates via Certbot
6. Start and persist PM2 processes across server reboots
7. Run health checks on both ports

---

## 1. DNS

In the DNS zone for `neximet.com`, create these **A records**, all pointing to the VPS public IPv4 address:

```text
backend       YOUR_VPS_IP
www.backend   YOUR_VPS_IP
portal        YOUR_VPS_IP
www.portal    YOUR_VPS_IP
```

Only publish AAAA records if the VPS also serves these sites over the specified IPv6 address. Correct old/stale A or AAAA records before requesting certificates. If using a DNS proxy/CDN, use DNS-only mode for the initial deployment and verification. Keep the webroot challenge reachable on port 80 for renewal.

## 2. Install system packages and create the application directory

Run as an administrator with sudo:

```bash
sudo apt-get update
sudo apt-get install -y nginx certbot curl git ca-certificates build-essential openssl ufw nano
sudo systemctl enable --now nginx
sudo install -d -m 0755 /var/www/neximet
sudo ufw allow OpenSSH
sudo ufw allow 'Nginx Full'
sudo ufw enable
```

If SSH uses a custom port, allow that actual SSH port before enabling UFW. Apply the same ingress policy in the VPS provider firewall: SSH, HTTP and HTTPS only. Do not open 4051, 4052 or a MongoDB port publicly.

Switch to the application user for Node, Git, npm and PM2 commands:

```bash
sudo -iu neximet
```

## 3. Install Node 22 and PM2 as neximet

```bash
curl --fail --location https://raw.githubusercontent.com/nvm-sh/nvm/v0.40.8/install.sh -o /tmp/neximet-nvm-install.sh
bash /tmp/neximet-nvm-install.sh
export NVM_DIR="$HOME/.nvm"
. "$NVM_DIR/nvm.sh"
nvm install 22
nvm alias default 22
node --version
npm install --global pm2
```

The backend's Node flag is already included in `npm start` and its PM2 configuration. This keeps `sanitize-html`/`htmlparser2` ESM interoperability working; setting NODE_OPTIONS from dotenv after Node has started would not be sufficient.

## 4. Put the code on the VPS

This workspace has separate backend/frontend repositories. Push the prepared changes to those repositories, then clone them with your own repository URLs:

```bash
cd /var/www/neximet
git clone YOUR_BACKEND_REPOSITORY_URL backend
git clone YOUR_FRONTEND_REPOSITORY_URL frontend
```

Alternatively transfer the prepared `backend/` and `frontend/` directories securely. Exclude Windows `node_modules`, `.next`, temporary files and local test databases; dependencies and the Next.js build must be produced on Linux.

Expected layout:

```text
/var/www/neximet/neximet-backend/package.json
/var/www/neximet/neximet-backend/ecosystem.config.js
/var/www/neximet/neximet-backend/deploy/nginx/...
/var/www/neximet/neximet-portal/package.json
/var/www/neximet/neximet-portal/ecosystem.config.js
/var/www/neximet/ecosystem.config.js
/var/www/neximet/deploy.sh
```

## 5. Configure backend secrets and MongoDB

**Migration:** securely copy the current backend secrets first. Preserve `MAIL_ENCRYPTION_KEY` and the effective `AI_ENCRYPTION_KEY` exactly, or existing saved mailbox/provider credentials cannot be decrypted. When AI previously fell back to the mail key, retain that same value. Preserve existing VAPID keys so subscriptions continue to work. Never copy secrets into frontend environment variables or Git.

**Fresh installation:** create a new environment file from the template. The commands below preserve an existing `.env`:

```bash
cd /var/www/neximet/backend
if [ ! -f .env ]; then cp .env.production.example .env; fi
nano .env
npm ci --omit=dev
npm run setup:production
chmod 600 .env
npm run check:production
```

Set these non-secret routing values:

```dotenv
NODE_ENV=production
HOST=127.0.0.1
PORT=4052
TRUST_PROXY=loopback
CORS_ORIGINS=https://portal.neximet.com,https://www.portal.neximet.com
```

Set `MONGODB_URI` to the existing production Atlas database or an authenticated MongoDB **replica set**. Allow the VPS IP in Atlas Network Access and use an application database user with the required read/write/index permissions. Startup refuses standalone MongoDB because attendance, leave and other changes use transactions. For Atlas, retain `retryWrites=true&w=majority` in the URI.

`setup:production` generates only blank JWT, encryption and VAPID values and preserves existing secrets. It does not choose your database, seed users or reset production data. Blank `CEO_MASTER_KEY` disables emergency recovery; if enabled, use a private random value of at least 32 characters. Public/example JWT and recovery secrets are rejected. Rotating a JWT secret signs users out; rotating credential-encryption keys without migration makes saved connections unreadable.

If migrating from another frontend domain, temporarily add its exact HTTPS origin to `CORS_ORIGINS` while switching users over. Do not use `*`. Users must sign in again when moving to a new browser origin.

Mail uses outbound Hostinger IMAP/SMTP, not a local mail server: allow outbound TCP 993 and 465, plus HTTPS 443 for AI and push services and the connection required by your MongoDB provider. Provider billing/free-tier limits still apply.

Do not run `npm run seed` against an existing database. Back up the database and all persistent encryption keys before moving traffic.

## 6. Configure and build the frontend

```bash
cd /var/www/neximet/frontend
if [ ! -f .env.production.local ]; then cp .env.production.example .env.production.local; fi
nano .env.production.local
npm ci
npm run check:production
npm run build
```

The environment file must contain:

```dotenv
NEXT_PUBLIC_API_URL=https://backend.neximet.com/api
NEXT_PUBLIC_BASE_URL=https://backend.neximet.com
NEXT_TELEMETRY_DISABLED=1
```

`BASE_URL` is the **backend origin**, including for private document downloads. These public values are compiled into the browser bundle during `npm run build`; a PM2 restart alone cannot change them. Remove stale exported `NEXT_PUBLIC_*` values from the build shell if they override the file. Keep development dependencies installed for subsequent builds.

## 7. Start the two PM2 applications

Run as `neximet`, without sudo:

```bash
cd /var/www/neximet
pm2 start ecosystem.config.js
pm2 status
curl --fail http://127.0.0.1:4052/api/health
curl --fail --head http://127.0.0.1:4051/login
node /var/www/neximet/backend/scripts/smoke-vps.js
```

If a process errors, inspect `pm2 logs neximet-backend --lines 100` or `pm2 logs neximet-frontend --lines 100`. Backend startup checks production configuration, database connectivity, transaction support and model indexes before signalling ready to PM2. `/health/live` reports process liveness; `/api/health` checks database readiness and returns 503 during outages/draining.

## 8. Bootstrap Nginx and request HTTPS certificates

The bootstrap file intentionally returns 503 for application traffic while serving ACME challenges. It does not reference certificates that have not yet been issued.

Disable any older site entries for these same four hostnames before enabling this site. Leave unrelated sites in place. On a customized Nginx installation that already sets `server_names_hash_bucket_size`, retain just one effective definition in the HTTP context; fresh Ubuntu defaults leave it commented out.

```bash
cd /var/www/neximet/backend
sudo install -d -m 0755 /var/www/letsencrypt
sudo install -m 0644 deploy/nginx/neximet.bootstrap.conf /etc/nginx/sites-available/neximet.conf
sudo ln -sfn /etc/nginx/sites-available/neximet.conf /etc/nginx/sites-enabled/neximet.conf
sudo nginx -t
sudo systemctl reload nginx
sudo certbot certonly --webroot -w /var/www/letsencrypt \
  --cert-name neximet-platform \
  -d backend.neximet.com -d www.backend.neximet.com \
  -d portal.neximet.com -d www.portal.neximet.com \
  --email YOUR_ADMIN_EMAIL --agree-tos --non-interactive
```

Keep the certificate name `neximet-platform`; the Nginx configuration uses that path. Verify all four DNS names resolve to the VPS before running Certbot.

Install the final TLS configuration after certificate issuance succeeds:

```bash
sudo install -m 0644 deploy/nginx/neximet-proxy.conf /etc/nginx/snippets/neximet-proxy.conf
sudo install -m 0644 deploy/nginx/neximet-tls.conf /etc/nginx/snippets/neximet-tls.conf
sudo install -m 0644 deploy/nginx/neximet.conf /etc/nginx/sites-available/neximet.conf
sudo nginx -t
sudo systemctl reload nginx
sudo install -m 0755 deploy/renew-nginx.sh /etc/letsencrypt/renewal-hooks/deploy/neximet-nginx
sudo systemctl enable --now certbot.timer
sudo certbot renew --dry-run
```

The final config enables TLS, HTTP-to-HTTPS redirects, login/recovery rate limits and upload size limits. It forwards `/api/socket.io` upgrades and disables proxy buffering for AI/Next.js streaming. Scope uploads are capped at 10 MB per file, with the aggregate MongoDB document size checked before saving. Private scope files require login and project access.

## 9. Persist PM2 across reboot and rotate logs

As `neximet`:

```bash
pm2 install pm2-logrotate
pm2 set pm2-logrotate:max_size 10M
pm2 set pm2-logrotate:retain 14
pm2 save
pm2 startup systemd -u neximet --hp /home/neximet
```

PM2 prints a command beginning with `sudo env PATH=...`; execute that exact command, which contains the installed Node path, then run `pm2 save` again. NVM/Node upgrades require refreshing that startup service with the new Node path. Nginx logs use the OS logrotate configuration.

## 10. Verify the public deployment

```bash
node /var/www/neximet/backend/scripts/smoke-vps.js --public
sudo nginx -t
pm2 status
```

The public script checks both backend names, the frontend, the www redirect, CORS and rejection of anonymous private-document requests. It performs no database writes or paid AI calls. Also sign in through `https://portal.neximet.com` and verify chat live updates, mail images/attachments, AI streaming with an available provider account, project downloads and CEO-only salary visibility. Attendance selfies, GPS and PWA notifications require HTTPS and browser permission.

Back up MongoDB, `backend/.env`, the TLS renewal configuration and any legacy files in `backend/uploads/`. Store encrypted backups outside the VPS and perform a restore test. Current scope documents, chat attachments and user settings are persisted in MongoDB. Keep application logs and backups access-controlled.

## Updates and rollback

These single-instance processes have brief restart downtime; schedule a maintenance window for builds/restarts. Keep the previous working Git revisions and back up `frontend/.next` **outside the frontend directory** before changing it. Do not rebuild over a live Next.js output directory.

```bash
cd /var/www/neximet/frontend
pm2 stop neximet-frontend
git pull --ff-only
npm ci
npm run build
pm2 restart ecosystem.config.js --update-env

cd /var/www/neximet/backend
pm2 stop neximet-backend
git pull --ff-only
npm ci --omit=dev
npm run check:production
pm2 restart ecosystem.config.js --update-env

pm2 save
node /var/www/neximet/backend/scripts/smoke-vps.js --public
```

For rollback, stop the affected process, check out its recorded previous revision, restore matching dependencies and the previous frontend `.next` output (or rebuild that revision), then restart its ecosystem file. Keep `.env` and encryption keys intact. Do not run destructive seed scripts or overwrite production data during a code rollback. Restore database backups only as a deliberate data recovery operation.

## Troubleshooting

- **502:** check PM2 status/logs and loopback readiness on 4051/4052. Do not expose those ports as a workaround.
- **Frontend calls an old API URL:** correct `.env.production.local`, remove conflicting exported values, rebuild, restart, then refresh the PWA.
- **Mail credentials cannot decrypt:** restore the original encryption key; generating a different key cannot decrypt old records.
- **AI reply stalls after deployment:** confirm the provided proxy configuration is active, inspect backend logs, and check provider quota/billing. Do not enable buffering on the stream route.
- **Chat falls back or disconnects:** verify HTTPS and the `/api/socket.io` upgrade headers; keep one backend instance unless deliberately configuring multi-instance operation.
- **401 on a copied scope URL:** expected; download through the signed-in project page.
- **Certificate validation fails:** check all four A/AAAA records, port 80 reachability and the bootstrap webroot. Do not install TLS config until the certificate exists.
- **Production configuration fails:** resolve the named environment variables. The checker never prints secret values.

References: [Next.js self-hosting](https://nextjs.org/docs/app/guides/self-hosting), [PM2 ecosystem files](https://pm2.keymetrics.io/docs/usage/application-declaration/), [PM2 startup persistence](https://pm2.keymetrics.io/docs/usage/startup/), [Nginx WebSocket proxying](https://nginx.org/en/docs/http/websocket.html), [Certbot webroot and renewal](https://eff-certbot.readthedocs.io/en/stable/using.html#webroot), [NVM installation](https://github.com/nvm-sh/nvm#install--update-script).

## Local verification commands

The prepared source was checked with the production frontend URLs, the frontend build, isolated-database attendance/private-upload tests, chat/mail/AI tests, and temporary real-Nginx TLS/WebSocket/SSE proxy tests. The production secrets setup was tested on in-memory sample configuration; it was not run against your existing secrets.

```bash
cd /var/www/neximet/backend
npm run test:production
cd /var/www/neximet/frontend
npm run test:production
```

Full attendance/chat integration suites also require a separate disposable local `mongod` binary. They never use the production `.env`. Optional real-Nginx verification uses `NGINX_BINARY=/usr/sbin/nginx npm run test:proxy` from the backend with OpenSSL installed. This starts temporary unprivileged loopback servers, without changing the system Nginx service. Run it as the application user.
