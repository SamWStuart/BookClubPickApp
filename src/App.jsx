import React, { useState, useEffect, useRef } from "react";
import {
  collection,
  doc,
  addDoc,
  updateDoc,
  deleteDoc,
  setDoc,
  onSnapshot,
  query,
  orderBy,
  writeBatch,
  serverTimestamp,
} from "firebase/firestore";
import { db } from "./firebase";
import {
  BookOpen,
  ChevronLeft,
  ChevronRight,
  Users,
  Settings,
  BarChart3,
  Search,
  Check,
  Loader2,
  Sparkles,
  Trash2,
  ArrowUp,
  ArrowDown,
  Layers,
  ListChecks,
  Pencil,
} from "lucide-react";

// Change this before you share the link with your editor.
const EDITOR_PASSCODE = "shelf2026";

const emptyForm = { title: "", author: "", coverUrl: "", synopsis: "" };

function getOrCreateVoterId() {
  let id = localStorage.getItem("voterId");
  if (!id) {
    id = crypto.randomUUID();
    localStorage.setItem("voterId", id);
  }
  return id;
}

// Guards every write so a stalled network request (permissions issue, blocked
// connection, misconfigured project, etc.) can't leave a button stuck on
// "Saving…" forever — it surfaces a clear error instead.
function withTimeout(promise, ms = 15000) {
  return Promise.race([
    promise,
    new Promise((_, reject) =>
      setTimeout(() => reject(new Error("TIMEOUT")), ms)
    ),
  ]);
}

function describeWriteError(e) {
  if (e?.message === "TIMEOUT") {
    return "That's taking too long — check your internet connection and Firebase setup, then try again.";
  }
  if (e?.code === "permission-denied") {
    return "Firestore rejected that write — double-check your security rules are published.";
  }
  return "Couldn't save — try again.";
}

// Google Books' intitle:/inauthor: operators bias relevance rather than
// strictly filter — a typo or unusual title can still surface a completely
// unrelated "best guess" result. This checks the returned title actually
// shares real words with what was typed before we trust it.
const STOPWORDS = new Set(["the", "a", "an", "of", "and", "or", "in", "on", "to", "for"]);
function significantWords(s) {
  return new Set(
    (s || "")
      .toLowerCase()
      .replace(/[^a-z0-9\s]/g, "")
      .split(/\s+/)
      .filter((w) => w.length > 2 && !STOPWORDS.has(w))
  );
}
function looksLikeMatch(queryTitle, hitTitle) {
  const q = significantWords(queryTitle);
  const h = significantWords(hitTitle);
  if (q.size === 0 || h.size === 0) return true; // nothing meaningful to compare, don't block
  let overlap = 0;
  for (const w of q) if (h.has(w)) overlap++;
  return overlap / q.size >= 0.5;
}

export default function App() {
  const [voterId] = useState(getOrCreateVoterId);
  const [booksLoaded, setBooksLoaded] = useState(false);
  const [error, setError] = useState("");
  const [saving, setSaving] = useState(false);

  const [books, setBooks] = useState([]);
  const [votes, setVotes] = useState({}); // { voterId: { name, first, second, votedAt } }

  const [name, setName] = useState(() => localStorage.getItem("voterName") || "");
  const [nameInput, setNameInput] = useState("");

  const [isEditor, setIsEditor] = useState(() => localStorage.getItem("isEditor") === "true");
  const [showGate, setShowGate] = useState(false);
  const [passInput, setPassInput] = useState("");
  const [passError, setPassError] = useState("");

  const [view, setView] = useState("deck"); // deck | rank | results | manage
  const [index, setIndex] = useState(0);
  const [flipped, setFlipped] = useState({});
  const [ranking, setRanking] = useState({ first: null, second: null });

  const [form, setForm] = useState(emptyForm);
  const [editingId, setEditingId] = useState(null); // book id being edited, or null when adding new
  const [lookupLoading, setLookupLoading] = useState(false);
  const [lookupNote, setLookupNote] = useState("");
  const lookupCacheRef = useRef({}); // avoid re-spending quota on a repeated identical lookup this session

  // ---- live subscriptions ----
  useEffect(() => {
    const q = query(collection(db, "books"), orderBy("order", "asc"));
    const unsub = onSnapshot(
      q,
      (snap) => {
        setBooks(snap.docs.map((d) => ({ id: d.id, ...d.data() })));
        setBooksLoaded(true);
      },
      (e) => {
        console.error(e);
        setError("Couldn't load the book list — check your Firebase setup.");
        setBooksLoaded(true);
      }
    );
    return unsub;
  }, []);

  useEffect(() => {
    const unsub = onSnapshot(
      collection(db, "votes"),
      (snap) => {
        const next = {};
        snap.docs.forEach((d) => (next[d.id] = d.data()));
        setVotes(next);
      },
      (e) => console.error(e)
    );
    return unsub;
  }, []);

  useEffect(() => {
    if (votes[voterId]) {
      setRanking({ first: votes[voterId].first ?? null, second: votes[voterId].second ?? null });
    }
  }, [voterId, votes]);

  const saveName = (n) => {
    setName(n);
    localStorage.setItem("voterName", n);
  };

  const unlockEditor = () => {
    if (passInput === EDITOR_PASSCODE) {
      setIsEditor(true);
      setShowGate(false);
      setPassInput("");
      setPassError("");
      localStorage.setItem("isEditor", "true");
    } else {
      setPassError("That's not it — try again.");
    }
  };

  // ---- cover/synopsis lookup: Google Books first, Open Library as fallback ----
  const lastLookupRef = useRef(0);
  const lookupGoogleBooks = async (title, author) => {
    const t = title.trim();
    const a = author.trim();
    // Quote each field so Google Books scopes the whole phrase to that field,
    // instead of only the first word — otherwise stray words leak into a
    // catalog-wide keyword search and can match a completely unrelated book.
    const q = encodeURIComponent(`intitle:"${t}"${a ? ` inauthor:"${a}"` : ""}`);
    const key = import.meta.env.VITE_GOOGLE_BOOKS_API_KEY;
    const url = `https://www.googleapis.com/books/v1/volumes?q=${q}&maxResults=1${key ? `&key=${key}` : ""}`;
    const res = await fetch(url);
    if (res.status === 429) {
      throw new Error("RATE_LIMITED");
    }
    const data = await res.json();
    const info = data?.items?.[0]?.volumeInfo;
    if (!info) return null;
    let coverUrl = info.imageLinks?.thumbnail || info.imageLinks?.smallThumbnail || "";
    coverUrl = coverUrl.replace(/^http:/, "https:").replace("&edge=curl", "");
    return {
      title: info.title || "",
      author: info.authors?.[0] || "",
      coverUrl,
      synopsis: info.description || "",
      source: "Google Books",
    };
  };

  const lookupOpenLibrary = async (title, author) => {
    const q = encodeURIComponent(`${title} ${author}`.trim());
    const res = await fetch(`https://openlibrary.org/search.json?q=${q}&limit=1`);
    const data = await res.json();
    const doc_ = data?.docs?.[0];
    if (!doc_) return null;
    let synopsis = "";
    if (doc_.key) {
      try {
        const wres = await fetch(`https://openlibrary.org${doc_.key}.json`);
        const wdata = await wres.json();
        synopsis =
          typeof wdata.description === "string" ? wdata.description : wdata.description?.value || "";
      } catch (e) {
        console.error(e);
      }
    }
    const coverUrl = doc_.cover_i ? `https://covers.openlibrary.org/b/id/${doc_.cover_i}-L.jpg` : "";
    return {
      title: doc_.title || "",
      author: doc_.author_name?.[0] || "",
      coverUrl,
      synopsis,
      source: "Open Library",
    };
  };

  const lookupBook = async () => {
    if (!form.title.trim()) return;
    const cacheKey = `${form.title.trim().toLowerCase()}|${form.author.trim().toLowerCase()}`;
    const cached = lookupCacheRef.current[cacheKey];
    if (cached) {
      if (cached.miss) {
        setLookupNote(cached.note);
      } else {
        setForm((f) => ({
          title: cached.hit.title || f.title,
          author: cached.hit.author || f.author,
          coverUrl: cached.hit.coverUrl || f.coverUrl,
          synopsis: cached.hit.synopsis || f.synopsis,
        }));
        setLookupNote(`${cached.note} (from this session's cache — no new request made)`);
      }
      return;
    }
    const now = Date.now();
    if (now - lastLookupRef.current < 4000) {
      setLookupNote("One sec — give it a few seconds between lookups so Google doesn't rate-limit us.");
      return;
    }
    lastLookupRef.current = now;
    setLookupLoading(true);
    setLookupNote("");
    try {
      let hit = null;
      let rateLimited = false;
      try {
        hit = await lookupGoogleBooks(form.title, form.author);
      } catch (e) {
        if (e?.message === "RATE_LIMITED") rateLimited = true;
        console.error(e);
      }
      if (!hit || !hit.coverUrl || !hit.synopsis) {
        try {
          const fallback = await lookupOpenLibrary(form.title, form.author);
          if (fallback) {
            hit = {
              title: hit?.title || fallback.title,
              author: hit?.author || fallback.author,
              coverUrl: hit?.coverUrl || fallback.coverUrl,
              synopsis: hit?.synopsis || fallback.synopsis,
              source: hit ? `${hit.source} + Open Library` : fallback.source,
            };
          }
        } catch (e) {
          console.error(e);
        }
      }
      if (!hit) {
        const note = rateLimited
          ? "Google Books is rate-limiting us right now — wait a minute and try again, or fill it in by hand."
          : "No match found in Google Books or Open Library — fill it in by hand.";
        // Don't cache a rate-limit miss — it's transient and worth retrying later.
        if (!rateLimited) lookupCacheRef.current[cacheKey] = { miss: true, note };
        setLookupNote(note);
        return;
      }
      if (!looksLikeMatch(form.title, hit.title)) {
        const note = `Closest match was "${hit.title}"${hit.author ? ` by ${hit.author}` : ""} — that doesn't look right for "${form.title}." Check the spelling and try again, or fill it in by hand.`;
        lookupCacheRef.current[cacheKey] = { miss: true, note };
        setLookupNote(note);
        return;
      }
      setForm((f) => ({
        title: hit.title || f.title,
        author: hit.author || f.author,
        coverUrl: hit.coverUrl || f.coverUrl,
        synopsis: hit.synopsis || f.synopsis,
      }));
      const note = `Found via ${hit.source}${!hit.coverUrl ? " — no cover art, add a URL manually if you have one." : ""}${
        !hit.synopsis ? " (no synopsis on file, worth double-checking)" : ""
      }.`;
      lookupCacheRef.current[cacheKey] = { hit, note };
      setLookupNote(note);
    } catch (e) {
      console.error(e);
      setLookupNote("Lookup failed — check the connection or fill it in by hand.");
    } finally {
      setLookupLoading(false);
    }
  };

  // ---- writes ----
  const saveBook = async () => {
    if (!form.title.trim()) return;
    setSaving(true);
    try {
      if (editingId) {
        await withTimeout(
          updateDoc(doc(db, "books", editingId), {
            title: form.title.trim(),
            author: form.author.trim(),
            coverUrl: form.coverUrl.trim(),
            synopsis: form.synopsis.trim(),
          })
        );
      } else {
        const maxOrder = books.reduce((m, b) => Math.max(m, b.order ?? 0), -1);
        await withTimeout(
          addDoc(collection(db, "books"), {
            title: form.title.trim(),
            author: form.author.trim(),
            coverUrl: form.coverUrl.trim(),
            synopsis: form.synopsis.trim(),
            order: maxOrder + 1,
            createdAt: serverTimestamp(),
          })
        );
      }
      setForm(emptyForm);
      setEditingId(null);
      setLookupNote("");
      setError("");
    } catch (e) {
      console.error(e);
      setError(describeWriteError(e));
    } finally {
      setSaving(false);
    }
  };

  const startEdit = (book) => {
    setEditingId(book.id);
    setForm({
      title: book.title || "",
      author: book.author || "",
      coverUrl: book.coverUrl || "",
      synopsis: book.synopsis || "",
    });
    setLookupNote("");
  };

  const cancelEdit = () => {
    setEditingId(null);
    setForm(emptyForm);
    setLookupNote("");
  };

  const removeBook = async (id) => {
    setSaving(true);
    try {
      const batch = writeBatch(db);
      batch.delete(doc(db, "books", id));
      // clear the book from anyone's saved ranking
      Object.entries(votes).forEach(([vId, v]) => {
        if (v.first === id || v.second === id) {
          batch.set(
            doc(db, "votes", vId),
            {
              first: v.first === id ? null : v.first,
              second: v.second === id ? null : v.second,
            },
            { merge: true }
          );
        }
      });
      await withTimeout(batch.commit());
      setIndex((i) => Math.min(i, Math.max(0, books.length - 2)));
      if (editingId === id) {
        setEditingId(null);
        setForm(emptyForm);
      }
      setError("");
    } catch (e) {
      console.error(e);
      setError(describeWriteError(e));
    } finally {
      setSaving(false);
    }
  };

  const moveBook = async (id, dir) => {
    const i = books.findIndex((b) => b.id === id);
    const j = dir === "up" ? i - 1 : i + 1;
    if (j < 0 || j >= books.length) return;
    setSaving(true);
    try {
      const batch = writeBatch(db);
      batch.update(doc(db, "books", books[i].id), { order: books[j].order ?? j });
      batch.update(doc(db, "books", books[j].id), { order: books[i].order ?? i });
      await withTimeout(batch.commit());
      setError("");
    } catch (e) {
      console.error(e);
      setError(describeWriteError(e));
    } finally {
      setSaving(false);
    }
  };

  const submitRanking = async () => {
    if (!ranking.first) return;
    setSaving(true);
    try {
      await withTimeout(
        setDoc(
          doc(db, "votes", voterId),
          { name, first: ranking.first, second: ranking.second, votedAt: serverTimestamp() },
          { merge: true }
        )
      );
      setError("");
    } catch (e) {
      console.error(e);
      setError(describeWriteError(e));
    } finally {
      setSaving(false);
    }
  };

  // ---- swipe deck ----
  const dragState = useRef({ startX: 0, startY: 0, dx: 0, dy: 0, dragging: false });
  const [dragX, setDragX] = useState(0);

  const onPointerDown = (e) => {
    dragState.current = { startX: e.clientX, startY: e.clientY, dx: 0, dy: 0, dragging: true };
  };
  const onPointerMove = (e) => {
    if (!dragState.current.dragging) return;
    const dx = e.clientX - dragState.current.startX;
    const dy = e.clientY - dragState.current.startY;
    dragState.current.dx = dx;
    dragState.current.dy = dy;
    // Only visually drag the card once the gesture is clearly horizontal —
    // otherwise scrolling the synopsis text (or anywhere else vertically)
    // would also nudge the card sideways.
    if (Math.abs(dx) > Math.abs(dy)) setDragX(dx);
  };
  const endDrag = () => {
    if (!dragState.current.dragging) return;
    const { dx, dy } = dragState.current;
    dragState.current.dragging = false;
    const isVerticalGesture = Math.abs(dy) > Math.abs(dx) && Math.abs(dy) > 10;
    if (isVerticalGesture) {
      // A real scroll/vertical drag, however small the horizontal component —
      // not a tap, not a horizontal swipe, so leave it alone and let the
      // browser's native scroll of the synopsis text stand.
    } else if (Math.abs(dx) < 6) {
      toggleFlip(index);
    } else if (dx < -60 && index < books.length - 1) {
      setIndex((i) => i + 1);
    } else if (dx > 60 && index > 0) {
      setIndex((i) => i - 1);
    }
    setDragX(0);
  };

  const toggleFlip = (i) => setFlipped((f) => ({ ...f, [i]: !f[i] }));

  const voteCounts = books.reduce((acc, b) => {
    acc[b.id] = { first: 0, second: 0 };
    return acc;
  }, {});
  Object.values(votes).forEach((v) => {
    if (v.first && voteCounts[v.first]) voteCounts[v.first].first += 1;
    if (v.second && voteCounts[v.second]) voteCounts[v.second].second += 1;
  });
  const totalVoters = Object.keys(votes).length;
  const results = [...books]
    .map((b) => ({
      ...b,
      firstCount: voteCounts[b.id]?.first || 0,
      secondCount: voteCounts[b.id]?.second || 0,
      points: (voteCounts[b.id]?.first || 0) * 2 + (voteCounts[b.id]?.second || 0),
    }))
    .sort((a, b) => b.points - a.points);
  const maxPoints = Math.max(1, ...results.map((r) => r.points));

  if (!name) {
    return (
      <div className="min-h-[100dvh] bg-[#16202B] flex items-center justify-center px-6">
        <div className="max-w-sm w-full">
          <div className="flex items-center gap-2 mb-3 justify-center">
            <BookOpen className="w-6 h-6 text-[#C9A227]" />
            <span className="text-[#EDE6D6] text-sm tracking-[0.2em] uppercase" style={{ fontFamily: "Inter, sans-serif" }}>
              Book Club
            </span>
          </div>
          <h1 className="text-3xl text-center text-[#F6F1E4] mb-6" style={{ fontFamily: "'Fraunces', serif" }}>
            Who's picking tonight?
          </h1>
          <input
            autoFocus
            value={nameInput}
            onChange={(e) => setNameInput(e.target.value)}
            onKeyDown={(e) => e.key === "Enter" && nameInput.trim() && saveName(nameInput.trim())}
            placeholder="Your name"
            className="w-full bg-[#1F2E3D] text-[#F6F1E4] placeholder-[#6B7C8C] border border-[#33465A] rounded-lg px-4 py-3 text-center outline-none focus:border-[#C9A227] transition-colors"
            style={{ fontFamily: "Inter, sans-serif" }}
          />
          <button
            onClick={() => nameInput.trim() && saveName(nameInput.trim())}
            disabled={!nameInput.trim()}
            className="w-full mt-3 bg-[#C9A227] disabled:bg-[#3a3627] disabled:text-[#6B7C8C] text-[#16202B] font-semibold rounded-lg py-3 transition-colors hover:bg-[#dbb52f]"
            style={{ fontFamily: "Inter, sans-serif" }}
          >
            Enter
          </button>
        </div>
      </div>
    );
  }

  return (
    <div
      className="h-[100dvh] bg-[#16202B] flex flex-col overflow-hidden"
      style={{ paddingTop: "env(safe-area-inset-top, 0px)", paddingBottom: "env(safe-area-inset-bottom, 0px)" }}
    >
      <header className="flex items-center justify-between px-4 py-3 flex-shrink-0">
        <div className="flex items-center gap-2">
          <BookOpen className="w-[18px] h-[18px] text-[#C9A227]" />
          <span className="text-[#F6F1E4]" style={{ fontFamily: "'Fraunces', serif", fontSize: "1.1rem" }}>
            Next Pick
          </span>
        </div>
        <div className="flex items-center gap-2 text-xs text-[#9FB0BE]" style={{ fontFamily: "Inter, sans-serif" }}>
          <Users className="w-3.5 h-3.5" />
          {totalVoters}
        </div>
      </header>

      {error && (
        <div className="mx-4 mb-2 text-xs text-[#e6b0a8] bg-[#3a2222] border border-[#5c3030] rounded-lg px-3 py-1.5 flex-shrink-0" style={{ fontFamily: "Inter, sans-serif" }}>
          {error}
        </div>
      )}

      <main className="flex-1 min-h-0 overflow-hidden">
        {!booksLoaded ? (
          <div className="h-full flex items-center justify-center">
            <Loader2 className="w-6 h-6 text-[#C9A227] animate-spin" />
          </div>
        ) : (
          <>
            {view === "deck" && (
              <DeckView
                books={books}
                index={index}
                setIndex={setIndex}
                flipped={flipped}
                dragX={dragX}
                onPointerDown={onPointerDown}
                onPointerMove={onPointerMove}
                endDrag={endDrag}
                onGoRank={() => setView("rank")}
                isEditor={isEditor}
                onGoManage={() => setView("manage")}
              />
            )}
            {view === "rank" && (
              <RankView
                books={books}
                ranking={ranking}
                setRanking={setRanking}
                onSubmit={submitRanking}
                saving={saving}
                hasVoted={!!votes[voterId]}
              />
            )}
            {view === "results" && <ResultsView results={results} totalVoters={totalVoters} maxPoints={maxPoints} />}
            {view === "manage" && isEditor && (
              <ManageView
                books={books}
                form={form}
                setForm={setForm}
                lookupBook={lookupBook}
                lookupLoading={lookupLoading}
                lookupNote={lookupNote}
                saveBook={saveBook}
                removeBook={removeBook}
                moveBook={moveBook}
                saving={saving}
                editingId={editingId}
                startEdit={startEdit}
                cancelEdit={cancelEdit}
              />
            )}
          </>
        )}
      </main>

      <nav className="flex-shrink-0 border-t border-[#2A3B4C] bg-[#16202B] px-2 py-1.5 flex items-center justify-around" style={{ fontFamily: "Inter, sans-serif" }}>
        <NavButton icon={Layers} label="Browse" active={view === "deck"} onClick={() => setView("deck")} />
        <NavButton icon={ListChecks} label="My picks" active={view === "rank"} onClick={() => setView("rank")} />
        <NavButton icon={BarChart3} label="Results" active={view === "results"} onClick={() => setView("results")} />
        <NavButton
          icon={Settings}
          label="Manage"
          active={view === "manage"}
          onClick={() => (isEditor ? setView("manage") : setShowGate(true))}
          dim={!isEditor}
        />
      </nav>

      {showGate && (
        <div className="fixed inset-0 bg-black/60 flex items-center justify-center px-6 z-50" onClick={() => setShowGate(false)}>
          <div
            className="bg-[#1F2E3D] border border-[#33465A] rounded-xl p-5 max-w-xs w-full"
            onClick={(e) => e.stopPropagation()}
            style={{ fontFamily: "Inter, sans-serif" }}
          >
            <h3 className="text-[#F6F1E4] mb-1" style={{ fontFamily: "'Fraunces', serif", fontSize: "1.2rem" }}>
              Editor access
            </h3>
            <p className="text-[#9FB0BE] text-sm mb-3">Enter the passcode to manage the book list.</p>
            <input
              autoFocus
              type="password"
              value={passInput}
              onChange={(e) => {
                setPassInput(e.target.value);
                setPassError("");
              }}
              onKeyDown={(e) => e.key === "Enter" && unlockEditor()}
              className="w-full bg-[#16202B] text-[#F6F1E4] border border-[#33465A] rounded-lg px-3 py-2 outline-none focus:border-[#C9A227] mb-2"
              placeholder="Passcode"
            />
            {passError && <p className="text-[#e6b0a8] text-xs mb-2">{passError}</p>}
            <div className="flex gap-2">
              <button onClick={() => setShowGate(false)} className="flex-1 border border-[#33465A] text-[#9FB0BE] rounded-lg py-2 text-sm">
                Cancel
              </button>
              <button onClick={unlockEditor} className="flex-1 bg-[#C9A227] text-[#16202B] font-semibold rounded-lg py-2 text-sm">
                Unlock
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

function NavButton({ icon: Icon, label, active, onClick, dim }) {
  return (
    <button
      onClick={onClick}
      className={`flex flex-col items-center gap-0.5 px-3 py-1.5 rounded-lg transition-colors ${
        active ? "text-[#C9A227]" : dim ? "text-[#41546a]" : "text-[#9FB0BE]"
      }`}
    >
      <Icon className="w-5 h-5" />
      <span className="text-[10px]">{label}</span>
    </button>
  );
}

function DeckView({ books, index, setIndex, flipped, dragX, onPointerDown, onPointerMove, endDrag, onGoRank, isEditor, onGoManage }) {
  if (books.length === 0) {
    return (
      <div className="h-full flex flex-col items-center justify-center px-8 text-center">
        <BookOpen className="w-10 h-10 text-[#3a4b5c] mb-3" />
        <p className="text-[#EDE6D6] mb-1" style={{ fontFamily: "'Fraunces', serif", fontSize: "1.3rem" }}>
          No books on the table yet
        </p>
        <p className="text-[#6B7C8C] text-sm mb-4" style={{ fontFamily: "Inter, sans-serif" }}>
          {isEditor ? "Add the first contender to get voting started." : "Ask your editor to add a few options."}
        </p>
        {isEditor && (
          <button onClick={onGoManage} className="bg-[#C9A227] text-[#16202B] font-semibold rounded-lg px-4 py-2 text-sm" style={{ fontFamily: "Inter, sans-serif" }}>
            Add a book
          </button>
        )}
      </div>
    );
  }

  const book = books[Math.min(index, books.length - 1)];
  const isFlipped = !!flipped[index];
  const atEnd = index === books.length - 1;

  return (
    <div className="h-full flex flex-col px-4 pt-2 pb-3">
      <div className="flex items-center justify-center gap-1.5 mb-2 flex-shrink-0">
        {books.map((_, i) => (
          <div
            key={i}
            className="rounded-full transition-all"
            style={{ width: i === index ? 16 : 6, height: 6, backgroundColor: i === index ? "#C9A227" : "#33465A" }}
          />
        ))}
      </div>

      <div
        className="flex-1 min-h-0 select-none"
        style={{ perspective: 1200 }}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={endDrag}
        onPointerCancel={endDrag}
        onPointerLeave={endDrag}
      >
        <div
          className="relative w-full h-full rounded-2xl shadow-2xl"
          style={{ transform: `translateX(${dragX}px) rotate(${dragX / 40}deg)`, transition: dragX === 0 ? "transform 0.25s ease" : "none" }}
        >
          <div
            className="relative w-full h-full"
            style={{ transformStyle: "preserve-3d", transition: "transform 0.5s cubic-bezier(.2,.8,.2,1)", transform: isFlipped ? "rotateY(180deg)" : "rotateY(0deg)" }}
          >
            <div className="absolute inset-0 rounded-2xl overflow-hidden bg-[#1F2E3D]" style={{ backfaceVisibility: "hidden" }}>
              <CoverImage book={book} />
              <div className="absolute inset-x-0 bottom-0 p-5 pt-16" style={{ background: "linear-gradient(to top, rgba(16,20,25,0.92), rgba(16,20,25,0))" }}>
                <h2 className="text-[#F6F1E4] leading-tight" style={{ fontFamily: "'Fraunces', serif", fontSize: "1.6rem" }}>
                  {book.title}
                </h2>
                {book.author && (
                  <p className="text-[#C9A227] text-sm mt-1" style={{ fontFamily: "Inter, sans-serif" }}>
                    {book.author}
                  </p>
                )}
                <p className="text-[#9FB0BE] text-xs mt-2" style={{ fontFamily: "Inter, sans-serif" }}>
                  Tap to read the synopsis
                </p>
              </div>
            </div>

            <div
              className="absolute inset-0 rounded-2xl overflow-hidden bg-[#F6F1E4] p-6 flex flex-col"
              style={{ backfaceVisibility: "hidden", transform: "rotateY(180deg)" }}
            >
              <h3 className="text-[#16202B] mb-1" style={{ fontFamily: "'Fraunces', serif", fontSize: "1.4rem" }}>
                {book.title}
              </h3>
              {book.author && (
                <p className="text-[#8B3A3A] text-sm mb-3" style={{ fontFamily: "Inter, sans-serif" }}>
                  {book.author}
                </p>
              )}
              <div className="flex-1 overflow-y-auto synopsis-scroll" style={{ touchAction: "pan-y" }}>
                <p className="text-[#3A3428] text-[0.95rem] leading-relaxed" style={{ fontFamily: "Inter, sans-serif" }}>
                  {book.synopsis || "No synopsis yet for this one."}
                </p>
              </div>
              <p className="text-[#7A6F55] text-xs mt-3 flex-shrink-0" style={{ fontFamily: "Inter, sans-serif" }}>
                Tap to flip back
              </p>
            </div>
          </div>
        </div>
      </div>

      <div className="flex items-center justify-between pt-3 flex-shrink-0">
        <button
          onClick={() => setIndex((i) => Math.max(0, i - 1))}
          disabled={index === 0}
          className="w-10 h-10 rounded-full bg-[#1F2E3D] disabled:opacity-30 text-[#EDE6D6] flex items-center justify-center"
        >
          <ChevronLeft className="w-5 h-5" />
        </button>
        <span className="text-[#6B7C8C] text-xs" style={{ fontFamily: "Inter, sans-serif" }}>
          {index + 1} of {books.length}
        </span>
        {atEnd ? (
          <button
            onClick={onGoRank}
            className="h-10 px-4 rounded-full bg-[#C9A227] text-[#16202B] text-sm font-semibold flex items-center gap-1.5"
            style={{ fontFamily: "Inter, sans-serif" }}
          >
            Rank picks <ChevronRight className="w-4 h-4" />
          </button>
        ) : (
          <button onClick={() => setIndex((i) => Math.min(books.length - 1, i + 1))} className="w-10 h-10 rounded-full bg-[#1F2E3D] text-[#EDE6D6] flex items-center justify-center">
            <ChevronRight className="w-5 h-5" />
          </button>
        )}
      </div>
    </div>
  );
}

function CoverImage({ book }) {
  const [errored, setErrored] = useState(false);
  const hasImage = book.coverUrl && !errored;
  return hasImage ? (
    <img src={book.coverUrl} alt={book.title} className="absolute inset-0 w-full h-full object-cover" onError={() => setErrored(true)} draggable={false} />
  ) : (
    <div className="absolute inset-0 flex items-center justify-center bg-gradient-to-br from-[#233042] to-[#16202B]">
      <BookOpen className="w-14 h-14 text-[#3a4b5c]" />
    </div>
  );
}

function RankView({ books, ranking, setRanking, onSubmit, saving, hasVoted }) {
  const pick = (id, slot) => {
    setRanking((r) => {
      const next = { ...r };
      if (next.first === id) next.first = null;
      if (next.second === id) next.second = null;
      if (slot === "first") {
        if (next.second === id) next.second = null;
        next.first = id;
      } else {
        if (next.first === id) next.first = null;
        next.second = id;
      }
      return next;
    });
  };

  if (books.length === 0) {
    return (
      <div className="h-full flex items-center justify-center px-8 text-center">
        <p className="text-[#6B7C8C] text-sm" style={{ fontFamily: "Inter, sans-serif" }}>
          Nothing to rank until books are added.
        </p>
      </div>
    );
  }

  return (
    <div className="h-full overflow-y-auto px-4 pt-3 pb-4">
      <h2 className="text-[#F6F1E4] mb-1" style={{ fontFamily: "'Fraunces', serif", fontSize: "1.3rem" }}>
        Rank your picks
      </h2>
      <p className="text-[#9FB0BE] text-xs mb-4" style={{ fontFamily: "Inter, sans-serif" }}>
        Tap 1st for your favorite, 2nd for your runner-up.
      </p>

      <div className="space-y-2.5">
        {books.map((b) => {
          const isFirst = ranking.first === b.id;
          const isSecond = ranking.second === b.id;
          return (
            <div
              key={b.id}
              className={`flex items-center gap-3 rounded-xl p-2.5 border-2 transition-colors ${
                isFirst ? "border-[#C9A227] bg-[#1F2E3D]" : isSecond ? "border-[#8B3A3A] bg-[#1F2E3D]" : "border-transparent bg-[#1a2733]"
              }`}
            >
              <div className="relative flex-shrink-0 rounded overflow-hidden bg-[#233042]" style={{ height: 60, width: 44 }}>
                <CoverImage book={b} />
              </div>
              <div className="flex-1 min-w-0">
                <p className="text-[#F6F1E4] text-sm truncate" style={{ fontFamily: "Inter, sans-serif", fontWeight: 600 }}>
                  {b.title}
                </p>
                {b.author && (
                  <p className="text-[#6B7C8C] text-xs truncate" style={{ fontFamily: "Inter, sans-serif" }}>
                    {b.author}
                  </p>
                )}
              </div>
              <div className="flex gap-1.5 flex-shrink-0">
                <button
                  onClick={() => pick(b.id, "first")}
                  className={`w-9 h-9 rounded-full text-xs font-bold flex items-center justify-center transition-colors ${
                    isFirst ? "bg-[#C9A227] text-[#16202B]" : "bg-[#233042] text-[#6B7C8C]"
                  }`}
                >
                  1st
                </button>
                <button
                  onClick={() => pick(b.id, "second")}
                  className={`w-9 h-9 rounded-full text-xs font-bold flex items-center justify-center transition-colors ${
                    isSecond ? "bg-[#8B3A3A] text-[#F6F1E4]" : "bg-[#233042] text-[#6B7C8C]"
                  }`}
                >
                  2nd
                </button>
              </div>
            </div>
          );
        })}
      </div>

      <button
        onClick={onSubmit}
        disabled={!ranking.first || saving}
        className="w-full mt-5 bg-[#C9A227] disabled:bg-[#3a3627] disabled:text-[#6B7C8C] text-[#16202B] font-semibold rounded-lg py-3 flex items-center justify-center gap-2"
        style={{ fontFamily: "Inter, sans-serif" }}
      >
        {saving ? <Loader2 className="w-4 h-4 animate-spin" /> : <Check className="w-4 h-4" />}
        {hasVoted ? "Update my picks" : "Save my picks"}
      </button>
    </div>
  );
}

function ResultsView({ results, totalVoters, maxPoints }) {
  if (results.length === 0) {
    return (
      <div className="h-full flex items-center justify-center px-8 text-center">
        <p className="text-[#6B7C8C] text-sm" style={{ fontFamily: "Inter, sans-serif" }}>
          Nothing to tally yet.
        </p>
      </div>
    );
  }
  return (
    <div className="h-full overflow-y-auto px-4 pt-3 pb-4">
      <h2 className="text-[#F6F1E4] mb-1" style={{ fontFamily: "'Fraunces', serif", fontSize: "1.3rem" }}>
        Results
      </h2>
      <p className="text-[#9FB0BE] text-xs mb-4" style={{ fontFamily: "Inter, sans-serif" }}>
        {totalVoters} {totalVoters === 1 ? "person has" : "people have"} voted · 1st choice = 2 pts, 2nd = 1 pt
      </p>
      <div className="space-y-4">
        {results.map((b, i) => (
          <div key={b.id}>
            <div className="flex justify-between items-baseline mb-1">
              <span className="text-[#F6F1E4] flex items-center gap-1.5" style={{ fontFamily: "'Fraunces', serif" }}>
                {i === 0 && b.points > 0 && <span className="text-[#C9A227]">★</span>}
                {b.title}
              </span>
              <span className="text-[#C9A227] text-xs" style={{ fontFamily: "Inter, sans-serif" }}>
                {b.points} pt{b.points === 1 ? "" : "s"}
              </span>
            </div>
            <div className="h-3 bg-[#1F2E3D] rounded-full overflow-hidden">
              <div
                className="h-full bg-gradient-to-r from-[#8B3A3A] to-[#C9A227] rounded-full transition-all duration-500"
                style={{ width: `${b.points === 0 ? 0 : Math.max((b.points / maxPoints) * 100, 4)}%` }}
              />
            </div>
            <p className="text-[#6B7C8C] text-xs mt-1" style={{ fontFamily: "Inter, sans-serif" }}>
              {b.firstCount} first-choice · {b.secondCount} second-choice
            </p>
          </div>
        ))}
      </div>
    </div>
  );
}

function ManageView({
  books,
  form,
  setForm,
  lookupBook,
  lookupLoading,
  lookupNote,
  saveBook,
  removeBook,
  moveBook,
  saving,
  editingId,
  startEdit,
  cancelEdit,
}) {
  return (
    <div className="h-full overflow-y-auto px-4 pt-3 pb-4" style={{ fontFamily: "Inter, sans-serif" }}>
      <h2 className="text-[#F6F1E4] mb-3" style={{ fontFamily: "'Fraunces', serif", fontSize: "1.3rem" }}>
        Manage the poll
      </h2>

      <div className={`bg-[#1F2E3D] border rounded-xl p-4 mb-5 ${editingId ? "border-[#C9A227]" : "border-[#33465A]"}`}>
        {editingId && (
          <div className="flex items-center justify-between mb-3">
            <span className="text-[#C9A227] text-xs uppercase tracking-wide flex items-center gap-1">
              <Pencil className="w-3 h-3" /> Editing
            </span>
            <button onClick={cancelEdit} className="text-[#9FB0BE] text-xs flex items-center gap-1 hover:text-[#F6F1E4]">
              <X className="w-3 h-3" /> Cancel
            </button>
          </div>
        )}
        <div className="space-y-2.5">
          <input
            value={form.title}
            onChange={(e) => setForm({ ...form, title: e.target.value })}
            placeholder="Title *"
            className="w-full bg-[#16202B] text-[#F6F1E4] placeholder-[#6B7C8C] border border-[#33465A] rounded-lg px-3 py-2 text-sm outline-none focus:border-[#C9A227]"
          />
          <input
            value={form.author}
            onChange={(e) => setForm({ ...form, author: e.target.value })}
            placeholder="Author"
            className="w-full bg-[#16202B] text-[#F6F1E4] placeholder-[#6B7C8C] border border-[#33465A] rounded-lg px-3 py-2 text-sm outline-none focus:border-[#C9A227]"
          />

          <button
            onClick={lookupBook}
            disabled={!form.title.trim() || lookupLoading}
            className="w-full flex items-center justify-center gap-1.5 border border-[#C9A227]/50 text-[#C9A227] disabled:opacity-40 rounded-lg py-2 text-sm"
          >
            {lookupLoading ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Search className="w-3.5 h-3.5" />}
            Look up cover & synopsis
          </button>
          {lookupNote && (
            <p className="text-[#9FB0BE] text-xs flex items-start gap-1">
              <Sparkles className="w-3 h-3 mt-0.5 flex-shrink-0" /> {lookupNote}
            </p>
          )}

          <input
            value={form.coverUrl}
            onChange={(e) => setForm({ ...form, coverUrl: e.target.value })}
            placeholder="Cover image URL"
            className="w-full bg-[#16202B] text-[#F6F1E4] placeholder-[#6B7C8C] border border-[#33465A] rounded-lg px-3 py-2 text-sm outline-none focus:border-[#C9A227]"
          />
          <textarea
            value={form.synopsis}
            onChange={(e) => setForm({ ...form, synopsis: e.target.value })}
            placeholder="Synopsis"
            rows={4}
            className="w-full bg-[#16202B] text-[#F6F1E4] placeholder-[#6B7C8C] border border-[#33465A] rounded-lg px-3 py-2 text-sm outline-none focus:border-[#C9A227] resize-none"
          />
          <button
            onClick={saveBook}
            disabled={!form.title.trim() || saving}
            className="w-full bg-[#C9A227] disabled:bg-[#3a3627] disabled:text-[#6B7C8C] text-[#16202B] font-semibold rounded-lg py-2.5 text-sm"
          >
            {saving ? "Saving…" : editingId ? "Save changes" : "Add to the poll"}
          </button>
        </div>
      </div>

      <p className="text-[#6B7C8C] text-xs mb-2 uppercase tracking-wide">{books.length} in the poll</p>
      <div className="space-y-2">
        {books.map((b, i) => (
          <div
            key={b.id}
            className={`flex items-center gap-2.5 rounded-lg p-2 border ${
              editingId === b.id ? "border-[#C9A227] bg-[#1F2E3D]" : "border-transparent bg-[#1a2733]"
            }`}
          >
            <div className="relative rounded overflow-hidden bg-[#233042] flex-shrink-0" style={{ width: 32, height: 44 }}>
              <CoverImage book={b} />
            </div>
            <div className="flex-1 min-w-0">
              <p className="text-[#F6F1E4] text-sm truncate">{b.title}</p>
              <p className="text-[#6B7C8C] text-xs truncate">{b.author}</p>
            </div>
            <button onClick={() => startEdit(b)} className="text-[#9FB0BE] hover:text-[#C9A227] p-1">
              <Pencil className="w-3.5 h-3.5" />
            </button>
            <button onClick={() => moveBook(b.id, "up")} disabled={i === 0} className="text-[#6B7C8C] disabled:opacity-20 p-1">
              <ArrowUp className="w-3.5 h-3.5" />
            </button>
            <button onClick={() => moveBook(b.id, "down")} disabled={i === books.length - 1} className="text-[#6B7C8C] disabled:opacity-20 p-1">
              <ArrowDown className="w-3.5 h-3.5" />
            </button>
            <button onClick={() => removeBook(b.id)} className="text-[#8B3A3A] p-1">
              <Trash2 className="w-3.5 h-3.5" />
            </button>
          </div>
        ))}
      </div>
    </div>
  );
}
