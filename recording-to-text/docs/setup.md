# Setup: Google Cloud and OpenAI access

Speech-to-text runs on paid services, so RecordingToText needs your own access to at least one of
them. Nothing of the kind comes with the repository: the committed `settings.env` only has
placeholders, and your own settings and keys go in `recording-to-text/.env`, which git ignores.

| Service | What it can do in RedDot | What you need |
|---|---|---|
| Google Cloud Speech-to-Text | every mode: Live, Per utterance, Per press | a Google Cloud project with billing, and the `gcloud` CLI |
| Whisper (OpenAI API) | Per utterance and Per press (it can't stream, so not Live) | an OpenAI API key |

The steps are done once. Run the commands from the repository's root folder.

## Google Cloud Speech-to-Text

**1. A project with billing.** Use an existing project, or create one. Its ID must be unique
across Google Cloud, so choose your own (e.g. `reddot-speech-` and a few digits):

```bash
PROJECT=your-project-id
```

```bash
gcloud projects create $PROJECT --name="RedDot speech"
```

Link it to a billing account (`gcloud billing accounts list` shows yours):

```bash
gcloud billing projects link $PROJECT --billing-account=BILLING_ACCOUNT_ID
```

**2. Turn on Speech-to-Text** in the project:

```bash
gcloud services enable speech.googleapis.com --project=$PROJECT
```

**3. Let the code use your Google login** on this computer ("application default credentials").
A browser window asks you to sign in:

```bash
gcloud auth application-default login
```

Each request names `GOOGLE_PROJECT` (step 4) as the project to bill, whatever your login's default
project is.

**4. Tell RecordingToText which project to use:**

```bash
printf 'GOOGLE_PROJECT=%s\n' "$PROJECT" >> recording-to-text/.env
```

**Recommended: a budget alert.** An e-mail at 50 %, 90 % and 100 % of a monthly amount (it doesn't
stop anything by itself). Use your billing account's currency; this needs
`gcloud services enable billingbudgets.googleapis.com --project=$PROJECT` once:

```bash
gcloud billing budgets create --billing-account=BILLING_ACCOUNT_ID --display-name="RedDot speech" --budget-amount=20USD --filter-projects=projects/$PROJECT --threshold-rule=percent=0.5 --threshold-rule=percent=0.9 --threshold-rule=percent=1.0
```

## Whisper (OpenAI API)

1. Create a key at https://platform.openai.com/api-keys (e.g. named "RedDot RecordingToText").
   Under **Settings → Limits**, a monthly budget is a good idea.
2. Add it to `recording-to-text/.env`. The key is typed invisibly and never appears on screen or in
   the shell history:

```bash
read -rsp "OpenAI API key: " KEY && printf 'OPENAI_API_KEY=%s\n' "$KEY" >> recording-to-text/.env && chmod 600 recording-to-text/.env && unset KEY && echo " saved"
```

With Whisper only, choose **Whisper** and **Per utterance** (or **Per press**) in the page's
settings: the page starts with Google and Live.

## Check

Start RecordingToText (its README: install, then `uvicorn`). Its log names each service at startup:
`warm-up: google ready` and `warm-up: whisper ready`, or why one isn't usable. A service you
didn't set up just shows as not usable; the others work. Common messages:

| Message | Fix |
|---|---|
| `google not usable: … Permission denied on resource project your-speech-project` | `GOOGLE_PROJECT` isn't set (that's the placeholder from `settings.env`): step 4 |
| `google not usable: … default credentials were not found` | no Google login on this computer: step 3 |
| `whisper not usable: the setting OPENAI_API_KEY is missing` | no OpenAI key in `recording-to-text/.env` |
