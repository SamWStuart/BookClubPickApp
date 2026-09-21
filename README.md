# Next Pick — Book Club Vote

A mobile-first book club poll: full-screen covers that flip to a synopsis, swipe
between titles, rank your top 2, and see live results. Backed by Firebase
Firestore so votes and books sync in real time for everyone with the link.

## 1. Create a Firebase project

1. Go to https://console.firebase.google.com → **Add project** (the free
   "Spark" plan is plenty for a book club).
2. Once created, click the **</> (Web)** icon to register a web app. Give it
   any nickname — you don't need Firebase Hosting, just the config.
3. Copy the `firebaseConfig` values it shows you (apiKey, authDomain, etc.).

## 2. Turn on Firestore

1. In the left sidebar: **Build → Firestore Database → Create database**.
2. Choose **Start in test mode** for now (you'll tighten this below).
3. Pick any region close to your group.

### Security rules

Go to the **Rules** tab of Firestore and paste this in:

```
rules_version = '2';
service cloud.firestore {
  match /databases/{database}/documents {
    match /books/{bookId} {
      allow read: if true;
      allow write: if true;
    }
    match /votes/{voteId} {
      allow read: if true;
      allow write: if true;
    }
  }
}
```

**Worth knowing:** this keeps things simple for a casual, unlisted-link book
club, but it means anyone who finds the link (or opens their browser's dev
tools) could technically write to the database directly — the "editor
passcode" in the app is a friendly gate, not real security, since it lives in
the JavaScript that ships to every visitor. If you ever want real
access control, that means adding Firebase Authentication and rules based on
signed-in users — a bigger change, happy to help with it if you get there.

## 3. Configure the app locally

```bash
cd book-club-firebase
cp .env.example .env
```

Open `.env` and fill in the six values from step 1:

```
VITE_FIREBASE_API_KEY=...
VITE_FIREBASE_AUTH_DOMAIN=...
VITE_FIREBASE_PROJECT_ID=...
VITE_FIREBASE_STORAGE_BUCKET=...
VITE_FIREBASE_MESSAGING_SENDER_ID=...
VITE_FIREBASE_APP_ID=...
```

Then also open `src/App.jsx` and change this line near the top to your own
passcode:

```js
const EDITOR_PASSCODE = "shelf2026";
```

### Optional: raise the Google Books lookup quota

The "Look up cover & synopsis" button calls Google Books' API. Without a key
it shares a low, unauthenticated quota — fine for occasional use, but a
string of rapid test lookups (typos, retries) can trip a `429 Too Many
Requests` error. This isn't a bug in the app or specific to local hosting —
it's Google's rate limit, and it applies the same way once deployed.

To raise it: go to https://console.cloud.google.com/apis/library/books.googleapis.com,
select the same project your Firebase app uses (or any project), enable the
"Books API", then create an API key under **APIs & Services → Credentials**.
Add it to `.env`:

```
VITE_GOOGLE_BOOKS_API_KEY=your-key-here
```

Not required — the app works fine without it, just with a lower ceiling
before you'll see occasional rate-limit messages during heavy testing.

## 4. Run it locally

```bash
npm install
npm run dev
```

Visit the local URL it prints — add a book or two, try voting, confirm it
all works before you deploy.

## 5. Push to GitHub

```bash
git init
git add .
git commit -m "Book club vote app"
git remote add origin <your-repo-url>
git push -u origin main
```

(`.env` is already in `.gitignore` — your Firebase keys won't get committed.
Firebase web config isn't a secret in the traditional sense, but there's no
reason to publish it either.)

## 6. Deploy on Netlify

1. Netlify → **Add new site → Import an existing project** → pick your repo.
2. Build command and publish directory are already set via `netlify.toml`
   (`npm run build`, `dist`) — Netlify should detect them automatically.
3. Before the first deploy, go to **Site configuration → Environment
   variables** and add the same `VITE_FIREBASE_*` values from your `.env`
   file (plus `VITE_GOOGLE_BOOKS_API_KEY` too, if you set one up).
4. Deploy. Share the resulting `*.netlify.app` URL with your book club.

Every visitor gets asked their name once (stored on their own device), and
anyone who knows your editor passcode can open **Manage** to add or remove
books. Votes and books update live for everyone via Firestore.
