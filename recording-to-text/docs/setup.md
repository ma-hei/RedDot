# Setup: Google Cloud project and OpenAI access

RecordingToText runs in its own Google Cloud project, so its costs show up separately in billing and
it can't affect other projects. These steps are done once.

| Setting | Value |
|---|---|
| Project name | RedDot |
| Project ID | `your-speech-project` (must be unique worldwide; if it's taken, pick another and use it everywhere below) |
| Billing account | `BILLING_ACCOUNT_ID` ("Mein Rechnungskonto", in CAD) |
| gcloud configuration | `reddot` (a separate set of gcloud settings; the other configurations stay as they are) |
| Speech-to-Text region | `us-central1` for chirp_2 (where it was tested on German audio for voice-input) |

## 1. Create the project and link billing

```bash
gcloud projects create your-speech-project --name="RedDot"
```
```bash
gcloud billing projects link your-speech-project --billing-account=BILLING_ACCOUNT_ID
```

## 2. A separate gcloud configuration

```bash
gcloud config configurations create reddot
```
```bash
gcloud config set account you@example.com
```
```bash
gcloud config set project your-speech-project
```

Switching back later: `gcloud config configurations activate other-app` (or `default`).

## 3. Enable the services it uses

```bash
gcloud services enable speech.googleapis.com run.googleapis.com secretmanager.googleapis.com cloudbuild.googleapis.com artifactregistry.googleapis.com billingbudgets.googleapis.com --project=your-speech-project
```

| Service | What for |
|---|---|
| `speech` (Speech-to-Text) | Google's transcription (chirp_2) |
| `run` (Cloud Run) | hosting RecordingToText (step 7) |
| `secretmanager` | the OpenAI API key on Cloud Run (step 7), never in the code |
| `cloudbuild`, `artifactregistry` | building and storing the container for Cloud Run (step 7) |
| `billingbudgets` | the budget alert below |

## 4. Recommended: a budget alert

An e-mail at 50 %, 90 % and 100 % of a monthly amount. It doesn't stop anything by itself. The
currency must be the billing account's currency (CAD).

```bash
gcloud billing budgets create --billing-account=BILLING_ACCOUNT_ID --display-name="RedDot" --budget-amount=20CAD --filter-projects=projects/your-speech-project --threshold-rule=percent=0.5 --threshold-rule=percent=0.9 --threshold-rule=percent=1.0
```

## 5. Local access to Google

The code uses your Google login on this computer ("application default credentials"), which is
already set up. It names `your-speech-project` as the project to bill in each request, so the login's
default quota project (used by the other app) doesn't need to change.

## 6. OpenAI API key (for Whisper)

1. Create a key at https://platform.openai.com/api-keys (e.g. named "RedDot RecordingToText").
   Under **Settings → Limits**, a monthly budget is a good idea, as with Google.
2. Store it in `recording-to-text/.env`, which git ignores. The key is typed invisibly and never
   appears on screen or in the shell history:

```bash
read -rsp "OpenAI API key: " KEY && printf 'OPENAI_API_KEY=%s\n' "$KEY" > ~/RedDot/recording-to-text/.env && chmod 600 ~/RedDot/recording-to-text/.env && unset KEY && echo " saved"
```

On Cloud Run, the key comes from Secret Manager instead (step 7).

## Check

```bash
gcloud services list --enabled --project=your-speech-project | grep -E 'speech|run'
```
```bash
grep -c OPENAI_API_KEY ~/RedDot/recording-to-text/.env
```

The first shows the two services; the second prints `1` (the key itself stays hidden).
