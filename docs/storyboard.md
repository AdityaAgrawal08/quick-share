# Quick-Share — UX Storyboard

**Version:** 1.0 · **Date:** 2026-10-17 · **Status:** draft (text panels; sketches pending)

## How to read this

Each scenario is a comic strip of **frames**. Every frame follows the same template:

- **Screen** — which app view is shown (matches the shipped UI in `client/src`).
- **Sketch** — wireframe placeholder + `TODO: sketch` slot for the hand-drawn / Figma panel (`docs/storyboard/frames/frame-<scenario>-<nn>.png`).
- **User does…** — the single action in this frame.
- **System responds…** — what the app shows next (real labels and copy).
- **Feeling** — the user's emotional state. This row is what makes it a storyboard, not a flowchart.

Scenarios: **A** cloud share + AI Q&A (happy path) · **B** private E2EE + burn-on-read ·
**C** live P2P transfer · **D** failure path.

---

## Scenario A — Cloud share + AI Q&A

### A1 — Home hero

```
+------------------------------------------+
|  QuickShare        P2P · Cloud · AI      |
|                                          |
|   Share anything, *instantly*            |
|                                          |
|  [ Start sharing ]    [ Join session ]   |
+------------------------------------------+
```

- **Screen:** home (`App.tsx` hero + Create/Join cards).
- **Sketch:** person at laptop thinking "need to send notes to a friend". TODO: sketch → `frames/frame-a-01.png`.
- **User does…** opens the app, reads the hero.
- **System responds…** hero + "Create a session" and "Join session" cards.
- **Feeling:** curious, oriented.

### A2 — Start sharing

```
+------------------------------------------+
|  [^ Upload icon ]  Start sharing         |
+------------------------------------------+
```

- **Screen:** home, "Start sharing" button (`data-testid="start-sharing"`).
- **Sketch:** finger tapping the primary button. TODO: sketch → `frames/frame-a-02.png`.
- **User does…** clicks **Start sharing**.
- **System responds…** publish form appears.
- **Feeling:** confident.

### A3 — Content

```
+------------------------------------------+
|  Message                                 |
|  [ Paste links, text snippets...      ]  |
|  Files                                   |
|  [ Drop files here or click to browse ]  |
+------------------------------------------+
```

- **Screen:** publish form (message `TextArea`, file dropzone with `aria-label="Choose files"`).
- **Sketch:** notes being pasted, files dropped; file pills appearing. TODO: sketch → `frames/frame-a-03.png`.
- **User does…** pastes text, drops files.
- **System responds…** file pills + byte counter (`x / 10 MB`).
- **Feeling:** in control.

### A4 — Open, AI-enabled

```
+------------------------------------------+
|  Privacy        [ Cloud ]                |
|  ( ) Open · AI-enabled  ( ) Private·E2EE |
|  Anyone with the code can read this      |
|  session. Indexed for AI with citations. |
+------------------------------------------+
```

- **Screen:** privacy card, Open tab (default), TTL picker.
- **Sketch:** toggle resting on Open; clock icon for expiry. TODO: sketch → `frames/frame-a-04.png`.
- **User does…** leaves defaults, sets ~1 hr expiry.
- **System responds…** hint that content is indexed for AI Q&A with citations.
- **Feeling:** informed.

### A5 — Launch

```
+------------------------------------------+
|  [  ⟳  Publishing…  ]                   |
+------------------------------------------+
```

- **Screen:** "Launch session" button → spinner state.
- **Sketch:** button morphing into spinner. TODO: sketch → `frames/frame-a-05.png`.
- **User does…** clicks **Launch session**.
- **System responds…** `Publishing…` spinner.
- **Feeling:** brief suspense.

### A6 — Code + QR

```
+------------------------------------------+
|   ● Session live      [ Cloud ]          |
|                                          |
|          4 8 2 9 1 3                     |
|         +--------+                        |
|         | QR CODE|  Scan to join from    |
|         +--------+  another device       |
|  [ Copy code ] [ Copy link ] [New session]|
+------------------------------------------+
```

- **Screen:** published card (`code-display`, `.qr-wrap`, copy buttons, expiry countdown).
- **Sketch:** publisher holding up phone showing QR to a friend. TODO: sketch → `frames/frame-a-06.png`.
- **User does…** copies the code, shows the QR.
- **System responds…** 6-digit code + QR + link + countdown.
- **Feeling:** confident, ready to share.

### A7 — Recipient joins

```
+------------------------------------------+
|  Join session            [6-digit code]   |
|  [ 4 8 2 9 1 3 ]  [ Join ]               |
+------------------------------------------+
```

- **Screen:** recipient home, Join card, `aria-label="Session code"`.
- **Sketch:** friend typing the code on their phone. TODO: sketch → `frames/frame-a-07.png`.
- **User does…** types the code, taps **Join**.
- **System responds…** session found, content prefetched.
- **Feeling:** hopeful.

### A8 — Content received

```
+------------------------------------------+
|  Session files                           |
|  ▸ notes.txt                             |
|  ▸ TL;DR text snippet…                   |
+------------------------------------------+
```

- **Screen:** receiver view with files/text.
- **Sketch:** friend reading the notes. TODO: sketch → `frames/frame-a-08.png`.
- **User does…** reads the content.
- **System responds…** rendered files and text.
- **Feeling:** satisfied.

### A9 — Ask the AI

```
+------------------------------------------+
|  Ask a question…               [ Send ]  |
+------------------------------------------+
```

- **Screen:** AI chat box (`aria-label="Ask about these files"`).
- **Sketch:** speech bubble with "?" over the files. TODO: sketch → `frames/frame-a-09.png`.
- **User does…** asks a question about the files.
- **System responds…** streaming answer with cited sources.
- **Feeling:** delighted.

### A10 — Verified answer

```
+------------------------------------------+
|  Answer … [1] [2]                        |
+------------------------------------------+
```

- **Screen:** answer with source citations.
- **Sketch:** checkmarks on the cited passages. TODO: sketch → `frames/frame-a-10.png`.
- **User does…** verifies the answer against the files.
- **System responds…** — (reading done).
- **Feeling:** trusts the app.

---

## Scenario B — Private E2EE + burn-on-read

### B1 — Private tab

```
+------------------------------------------+
|  ( ) Open · AI-enabled  (*) Private·E2EE |
|  Encrypted locally with AES-256-GCM.     |
|  Server stores ciphertext only — AI off. |
+------------------------------------------+
```

- **Screen:** privacy card, Private tab.
- **Sketch:** shield icon closing over the files. TODO: sketch → `frames/frame-b-01.png`.
- **User does…** switches to **Private · E2EE**.
- **System responds…** callout: ciphertext-only server storage, AI stays off.
- **Feeling:** secure.

### B2 — Password

```
+------------------------------------------+
|  🔒 [ ●●●●●●●●●●●● ]                     |
|  Set a strong private password           |
+------------------------------------------+
```

- **Screen:** `publish-password-input` (`Set a strong private password`).
- **Sketch:** key turning in a lock. TODO: sketch → `frames/frame-b-02.png`.
- **User does…** sets a strong password.
- **System responds…** masked field accepted.
- **Feeling:** cautious but OK.

### B3 — Burn toggle

```
+------------------------------------------+
|  (●) Burn after first retrieval [One-time]|
+------------------------------------------+
```

- **Screen:** "Burn after first retrieval" toggle ON.
- **Sketch:** fuse lit on an envelope. TODO: sketch → `frames/frame-b-03.png`.
- **User does…** enables burn-on-read.
- **System responds…** One-time badge.
- **Feeling:** extra safe.

### B4 — Share kit

```
+------------------------------------------+
|  4 8 2 9 1 3   + QR                      |
|  Password  [ ●●●●●●●● ] [Show] [Copy]    |
+------------------------------------------+
```

- **Screen:** published card + password row with Show/Copy.
- **Sketch:** code, QR and password sent via separate channels (split arrows). TODO: sketch → `frames/frame-b-04.png`.
- **User does…** copies code, link, and password.
- **System responds…** full share kit displayed.
- **Feeling:** organized.

### B5 — Recipient authenticates

```
+------------------------------------------+
|  [ 4 8 2 9 1 3 ]  [ Join ]               |
|  🔒 [ ●●●●●●●●●●●● ]                     |
+------------------------------------------+
```

- **Screen:** join code + `join-password-input` (`Session password`).
- **Sketch:** friend entering both secrets. TODO: sketch → `frames/frame-b-05.png`.
- **User does…** enters code and password.
- **System responds…** `Authenticating…` → decrypted content.
- **Feeling:** anticipation.

### B6 — Decrypted view

```
+------------------------------------------+
|  🔓 notes.txt (decrypted locally)        |
+------------------------------------------+
```

- **Screen:** receiver view, plaintext rendered.
- **Sketch:** lock springing open. TODO: sketch → `frames/frame-b-06.png`.
- **User does…** reads the files.
- **System responds…** locally decrypted content.
- **Feeling:** relieved.

### B7 — Self-destruct

```
+------------------------------------------+
|  This session has expired.               |
+------------------------------------------+
```

- **Screen:** expired state after first retrieval.
- **Sketch:** envelope turning to ash. TODO: sketch → `frames/frame-b-07.png`.
- **User does…** tries reopening the link.
- **System responds…** `This session has expired.` — files unrecoverable.
- **Feeling:** trust confirmed.

---

## Scenario C — Live P2P large file

### C1 — Fallback banner

```
+------------------------------------------+
|  ⚠ Cloud storage is currently unavailable|
|    — falling back to Live P2P.           |
|  Mode: [ Live P2P ]                      |
+------------------------------------------+
```

- **Screen:** publish form with unavailable-cloud banner, Live P2P mode.
- **Sketch:** cloud with a crack, arrow to two phones linked directly. TODO: sketch → `frames/frame-c-01.png`.
- **User does…** reads the banner, continues.
- **System responds…** mode badge flips to Live P2P.
- **Feeling:** mildly concerned, guided.

### C2 — Session password

```
+------------------------------------------+
|  🔒 [ ●●●●●●●●●●●● ]                     |
|  Set session password (required)         |
+------------------------------------------+
```

- **Screen:** `publish-password-input` (required for live signaling).
- **Sketch:** handshake behind a lock. TODO: sketch → `frames/frame-c-02.png`.
- **User does…** sets the session password.
- **System responds…** requirement satisfied, Launch enabled.
- **Feeling:** OK.

### C3 — Waiting room

```
+------------------------------------------+
|  ● Live P2P        [ Waiting… ]          |
|  4 8 2 9 1 3                             |
|  Waiting for recipients…                 |
|  (keep this tab open)                    |
+------------------------------------------+
```

- **Screen:** live session card, 0 peers.
- **Sketch:** publisher watching a door. TODO: sketch → `frames/frame-c-03.png`.
- **User does…** keeps the tab open, shares the code.
- **System responds…** signaling active, waiting state.
- **Feeling:** patient.

### C4 — Peer connects

```
+------------------------------------------+
|  ● Live P2P        [ 1 connected ]      |
|  Peer ab12 · channel open                |
+------------------------------------------+
```

- **Screen:** recipient row appears, channel state open.
- **Sketch:** two phones with a lightning link. TODO: sketch → `frames/frame-c-04.png`.
- **User does…** (recipient) enters code + password and joins.
- **System responds…** WebRTC connects directly between browsers.
- **Feeling:** encouraged.

### C5 — Transfer

```
+------------------------------------------+
|  big-video.mp4                           |
|  ████████████░░░░░░  68% · 2.1 MB/s      |
+------------------------------------------+
```

- **Screen:** transfer progress with speed/ETA.
- **Sketch:** film reel flowing phone-to-phone. TODO: sketch → `frames/frame-c-05.png`.
- **User does…** watches progress.
- **System responds…** device-to-device bytes, no size cap.
- **Feeling:** engaged.

### C6 — Done

```
+------------------------------------------+
|  Transfer complete  [ Exit session ]     |
+------------------------------------------+
```

- **Screen:** completion state, Exit session.
- **Sketch:** checkmark flag at finish line. TODO: sketch → `frames/frame-c-06.png`.
- **User does…** exits / closes the tab.
- **System responds…** session torn down.
- **Feeling:** accomplished.

---

## Scenario D — Failure path

### D1 — Wrong code

```
+------------------------------------------+
|  [ 4 8 2 9 1 4 ]  [ Join ]               |
|  ⚠ Session not found. Check the code.    |
+------------------------------------------+
```

- **Screen:** join card with error callout.
- **Sketch:** typo circled in red. TODO: sketch → `frames/frame-d-01.png`.
- **User does…** taps Join with a typo'd code.
- **System responds…** `Session not found. Check the code.`
- **Feeling:** frustrated but guided.

### D2 — Retry

```
+------------------------------------------+
|  [ 4 8 2 9 1 3 ]  [ Join ]               |
+------------------------------------------+
```

- **Screen:** corrected code.
- **Sketch:** backspace fixing the digit. TODO: sketch → `frames/frame-d-02.png`.
- **User does…** fixes the code, rejoins.
- **System responds…** session found, content loads.
- **Feeling:** recovered.

### D3 — Expired link (alt)

```
+------------------------------------------+
|  This session has expired.               |
+------------------------------------------+
```

- **Screen:** expired state on an old link.
- **Sketch:** faded, torn ticket. TODO: sketch → `frames/frame-d-03.png`.
- **User does…** opens yesterday's link.
- **System responds…** `This session has expired.`
- **Feeling:** understands ephemerality.

---

## Sketch TODO (for the artist — paper, Figma, or Miro)

Replace each `TODO: sketch` above with an image saved as `docs/storyboard/frames/frame-<scenario>-<nn>.png` and embed it under the frame:

```markdown
![Frame A1](frames/frame-a-01.png)
```

26 frames total: A 10 · B 7 · C 6 · D 3. Keep panels rough — stick figures and boxes are fine; fidelity to the flow matters more than polish.

## Verification log

- [x] Frame copy checked against `client/src/App.tsx` (labels, error strings, QR caption).
- [ ] Walked live against running app (backend :3002 + client :4000).
- [ ] All images embedded and loading on GitHub.
