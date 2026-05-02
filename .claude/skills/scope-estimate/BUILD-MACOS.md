# Build exec-db on macOS — literal step by step

Assumes a fresh Mac, no GitHub account, no terminal experience, no
Homebrew, no Node, no Postgres. Each numbered step is one action.
Estimated total time: 60–90 minutes. Follow the categories in order.

---

## Category 1 — Accounts to create (15 min)

You need three free accounts before any install.

1. **GitHub account** (to download the code).
   1. Open <https://github.com/signup> in Safari.
   2. Enter your email, create a password, pick a username.
   3. Verify the email link GitHub sends you.
   4. Stay on the free plan — no payment needed.

2. **Anthropic API account** (for Claude Code + the skill's LLM calls).
   1. Open <https://console.anthropic.com/>.
   2. Sign up with email or Google.
   3. Click **Settings → Billing** and add a payment method.
   4. Click **Settings → API Keys → Create Key**.
   5. Copy the key (starts with `sk-ant-…`) into a temporary note. You will paste it into a config file in Category 6.

3. **Skip Google Cloud / Workspace for now.** It's only needed for PR2/PR3 (Gmail + Calendar). PR1 runs without it.

---

## Category 2 — macOS prerequisites (20 min)

All commands go in the **Terminal** app. Open it: press `⌘+Space`, type `Terminal`, press Enter.

4. **Install Apple's command-line developer tools.**
   ```bash
   xcode-select --install
   ```
   A dialog appears. Click **Install**, accept the license, wait ~5 min.

5. **Install Homebrew** (the macOS package installer).
   ```bash
   /bin/bash -c "$(curl -fsSL https://raw.githubusercontent.com/Homebrew/install/HEAD/install.sh)"
   ```
   It will ask for your Mac password. Type it (characters won't show — normal). Wait until it prints `Installation successful!`

6. **Add Homebrew to your shell PATH** (Apple Silicon Macs only — M1/M2/M3/M4).
   ```bash
   echo 'eval "$(/opt/homebrew/bin/brew shellenv)"' >> ~/.zprofile
   eval "$(/opt/homebrew/bin/brew shellenv)"
   ```
   On Intel Macs, skip this step — Homebrew handles PATH automatically.

7. **Install Git, Node 20, pnpm, and Postgres 16** in one command.
   ```bash
   brew install git node@20 pnpm postgresql@16
   ```

8. **Make Node 20 the default.**
   ```bash
   brew link --overwrite node@20
   ```

9. **Verify everything installed.**
   ```bash
   git --version && node --version && pnpm --version && psql --version
   ```
   You should see four version lines, no errors.

---

## Category 3 — Git identity setup (3 min)

10. **Tell Git who you are** (use the same email as your GitHub account).
    ```bash
    git config --global user.name "Your Name"
    git config --global user.email "you@example.com"
    git config --global init.defaultBranch main
    ```

11. **Create a GitHub Personal Access Token** so Git can talk to GitHub.
    1. Open <https://github.com/settings/tokens?type=beta>.
    2. Click **Generate new token**.
    3. Name it `mac-laptop`, expiration `90 days`, repository access `All repositories`, permissions: **Contents: Read and write**.
    4. Click **Generate token**. Copy the value into your temporary note (starts with `github_pat_…`).

12. **Cache the token in macOS Keychain** so you only paste it once.
    ```bash
    git config --global credential.helper osxkeychain
    ```

---

## Category 4 — Download the code (5 min)

13. **Pick a folder for code.**
    ```bash
    mkdir -p ~/code && cd ~/code
    ```

14. **Clone the repo.**
    ```bash
    git clone https://github.com/haremantra/exec-db.git
    cd exec-db
    ```
    When prompted for a username, type your GitHub username. When prompted for a password, paste the **token** from step 11 (not your GitHub password).

15. **Switch to the branch with the skill.** (The `main` branch may not have the skill until PR #3 is merged.)
    ```bash
    git checkout claude/skill-cost-time-estimate-Y5LVD
    ```
    If PR #3 is already merged, skip this — you can stay on `main`.

---

## Category 5 — Start Postgres (5 min)

16. **Launch Postgres in the background.**
    ```bash
    brew services start postgresql@16
    ```

17. **Add Postgres tools to your PATH** (one-time).
    ```bash
    echo 'export PATH="/opt/homebrew/opt/postgresql@16/bin:$PATH"' >> ~/.zprofile
    eval "$(/opt/homebrew/bin/brew shellenv)"
    export PATH="/opt/homebrew/opt/postgresql@16/bin:$PATH"
    ```

18. **Create the database and roles the app expects.**
    ```bash
    createuser -s postgres 2>/dev/null || true
    createdb -O postgres exec_db
    psql -d exec_db -c "CREATE ROLE app_runtime LOGIN PASSWORD 'devpass';"
    ```

19. **Verify.**
    ```bash
    psql -d exec_db -c '\du'
    ```
    You should see `postgres` and `app_runtime` listed.

---

## Category 6 — Configure environment (3 min)

20. **Copy the example env file.**
    ```bash
    cp .env.example .env
    ```

21. **Open `.env` in TextEdit** to fill in three values.
    ```bash
    open -e .env
    ```

22. **Edit these three lines:**
    - `DATABASE_URL=postgres://postgres@localhost:5432/exec_db`
    - `DATABASE_URL_APP=postgres://app_runtime:devpass@localhost:5432/exec_db`
    - `ANTHROPIC_API_KEY=sk-ant-…` *(paste your key from step 2.4)*

    Save (`⌘+S`) and close TextEdit.

---

## Category 7 — Install dependencies and run the app (10 min)

23. **Install all Node packages.**
    ```bash
    pnpm install
    ```
    First run takes 3–5 min.

24. **Apply the database schema.**
    ```bash
    pnpm db:push
    ```

25. **Apply row-level security and audit triggers.**
    ```bash
    pnpm db:rls
    ```

26. **Start the dev server.**
    ```bash
    pnpm dev
    ```
    Wait until you see `Ready in …`.

27. **Open the app.**
    Open <http://localhost:3000> in Safari. You should see the exec-db UI.

To stop the server: press `Ctrl+C` in the Terminal window.

---

## Category 8 — Install Claude Code (5 min)

28. **Download Claude Code.**
    Open <https://claude.com/claude-code> and click the macOS download button. Open the downloaded file and drag Claude Code to **Applications**.

29. **Launch Claude Code.**
    Open it from Applications. When asked to log in, use your Anthropic account from step 2.

30. **Open the project in Claude Code.**
    From Claude Code's menu pick **Open Folder…** and choose `~/code/exec-db`.

---

## Category 9 — Run the skill (5 min)

31. **(Optional) Pick a conversation style.**
    In Claude Code's file tree open `.claude/skills/scope-estimate/style.md`. Change `active_style: concise` to `executive-brief` (or whichever) and save.

32. **In Claude Code's chat, type:**
    ```
    crystallize my workflow and give me user stories, then estimate the build
    ```

33. **Answer the questions Claude asks.**
    It runs in batches of 6–10. You can stop and resume any time. Say `use defaults` for any technical question you don't want to answer.

34. **Read your outputs.**
    Three files appear under `docs/`:
    - `docs/exec-workflow.md`
    - `docs/user-stories.md`
    - `docs/scope-answers.md` (with the **Estimates** block at the bottom)

    Open them in Claude Code's preview, or in TextEdit:
    ```bash
    open -e docs/exec-workflow.md docs/user-stories.md docs/scope-answers.md
    ```

---

## Category 10 — Optional polish

35. **Run the standalone vision-check CLI.**
    ```bash
    pnpm vision-check
    ```
    Walks you through a product-vision interview, writes `docs/vision.md`.

36. **Save your work to GitHub.**
    ```bash
    git add docs/
    git commit -m "add my exec workflow + scope answers"
    git push
    ```
    First push asks for username + token again (step 11) unless Keychain cached it.

---

## Troubleshooting cheat sheet

| Symptom | Fix |
|---|---|
| `command not found: brew` | Re-run step 6 — PATH not loaded |
| `command not found: pnpm` | Run `brew install pnpm` again |
| `psql: connection refused` | Run `brew services start postgresql@16` |
| `pnpm install` fails on `engines` check | Run `node --version`; if not v20.x, run `brew link --overwrite node@20` |
| Port 3000 already in use | Run `lsof -ti:3000 \| xargs kill -9` then `pnpm dev` again |
| `git push` rejected | Token expired — generate a new one (step 11) and paste when prompted |
| Claude Code doesn't see the skill | Confirm `.claude/skills/scope-estimate/SKILL.md` exists in the open folder |

---

## What you now have

- Postgres running locally with the exec-db schema, RLS, and audit triggers.
- The Next.js app on <http://localhost:3000>.
- Claude Code wired to your Anthropic account.
- The `scope-estimate` skill ready to interview you and write three docs.
- A GitHub identity that can push your answers back to the repo.
