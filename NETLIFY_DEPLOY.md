# Deploying Project Pulse to Netlify

The frontend is built with Vite and served by Netlify. The login and quiz result API runs as a Netlify Function and requires a hosted PostgreSQL database.

## 1. Prepare PostgreSQL

Create a PostgreSQL database with a provider such as Neon, Supabase, or another managed PostgreSQL host. Copy its connection string. The database user must be allowed to create tables and indexes; the function creates `users` and `quiz_attempts` tables on first use.

## 2. Push the project to Git

Commit and push the project to a Git provider supported by Netlify.

## 3. Create the Netlify site

In Netlify, choose **Add new site → Import an existing project** and select the repository. Use these settings:

- Base directory: `frontend`
- Build command: `npm run build`
- Publish directory: `dist`
- Functions directory: `netlify/functions`

The repository's `netlify.toml` already supplies these settings.

## 4. Set environment variables

In **Site configuration → Environment variables**, add:

- `DATABASE_URL`: the PostgreSQL connection string from step 1.
- `JWT_SECRET`: a long, random secret used to sign login sessions. Generate one locally, for example with `node -e "console.log(require('node:crypto').randomBytes(48).toString('hex'))"`.
- `MEMBER_PASSWORD_23BQ1A4202`, `MEMBER_PASSWORD_23BQ1A4231`, `MEMBER_PASSWORD_23BQ1A4251`, and `MEMBER_PASSWORD_24BQ5A4203`: set each to a distinct password before sharing the site. If omitted, each password defaults to that account's member ID.

Set these variables for production and deploy previews if you want previews to support login. Do not commit either secret to Git. Trigger a new deploy after setting or changing them.

## 5. Verify the live site

Open the deployed URL, sign in with one of the configured member accounts, complete the quiz, then reload and sign in again to confirm the session cookie and result saving work.

Configured initial accounts use the member ID as both username and password:

- `23BQ1A4202`
- `23BQ1A4231`
- `23BQ1A4251`
- `24BQ5A4203`

The function seeds these accounts automatically when it initializes the database and applies the configured passwords on its next invocation. Keep the password variables set in Netlify so they remain in effect after future database initialization.

## Local development

The existing Node and FastAPI backend servers are intended for local development. For a local Netlify-style run, install the Netlify CLI and run `netlify dev` from the repository root after configuring the variables above in a local `.env` file. Never commit `.env` files.
