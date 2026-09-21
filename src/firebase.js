import { initializeApp } from "firebase/app";
import { initializeFirestore } from "firebase/firestore";

// These come from your Netlify / local .env file — see .env.example.
const firebaseConfig = {
  apiKey: import.meta.env.VITE_FIREBASE_API_KEY,
  authDomain: import.meta.env.VITE_FIREBASE_AUTH_DOMAIN,
  projectId: import.meta.env.VITE_FIREBASE_PROJECT_ID,
  storageBucket: import.meta.env.VITE_FIREBASE_STORAGE_BUCKET,
  messagingSenderId: import.meta.env.VITE_FIREBASE_MESSAGING_SENDER_ID,
  appId: import.meta.env.VITE_FIREBASE_APP_ID,
};

const missingKeys = Object.entries(firebaseConfig)
  .filter(([, v]) => !v)
  .map(([k]) => k);
if (missingKeys.length > 0) {
  // Fails loudly and specifically instead of letting every later Firestore
  // call silently hang or reject with a cryptic error. The most common cause:
  // .env was created/edited after `npm run dev` was already running — Vite
  // only reads .env at server start, so restart the dev server.
  throw new Error(
    `Missing Firebase config values: ${missingKeys.join(", ")}. Check your .env file, ` +
      `and make sure you restarted "npm run dev" after creating or editing it.`
  );
}

export const app = initializeApp(firebaseConfig);

// Firestore's default streaming connection ("WebChannel") can get stuck in a
// failing reconnect loop behind certain browser extensions, VPNs, or
// network/proxy setups — writes and listeners hang or time out even though
// everything is configured correctly. Auto-detecting and falling back to
// plain long-polling when needed fixes it, with no downside for people whose
// connection works fine with the default transport.
export const db = initializeFirestore(app, {
  experimentalAutoDetectLongPolling: true,
  useFetchStreams: false,
});
