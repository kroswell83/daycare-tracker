import { useEffect, useMemo, useState } from "react";
import * as XLSX from "xlsx";

import { auth, db, provider } from "./firebase";
import { signInWithPopup, onAuthStateChanged, signOut } from "firebase/auth";
import type { User } from "firebase/auth";
import {
  collection,
  doc,
  getDoc,
  setDoc,
  onSnapshot,
  query,
  orderBy,
  serverTimestamp,
} from "firebase/firestore";

type Kid = { id: string; name: string; active: boolean };

type RecordRow = {
  id: string; // `${date}_${kidId}`
  date: string;
  kidId: string;
  kidName: string;

  // We store "" (empty string) when cleared to avoid Firestore undefined/delete issues
  inTime?: string;  // "HH:MM" or ""
  outTime?: string; // "HH:MM" or ""

  breakfast: number;
  amSnack: number;
  lunch: number;
  pmSnack: number;

  // audit/metadata
  source?: "auto" | "manual";
  editedBy?: string;
  editReason?: string; // "" allowed
  updatedAt?: any;
};

const MEALS = {
  breakfast: { start: "09:00", end: "09:30" },
  amSnack: "11:00",
  lunch: "13:00",
  pmSnack: "15:00",
};

const today = () => new Date().toISOString().slice(0, 10);

const toMin = (t?: string) =>
  t ? Number(t.slice(0, 2)) * 60 + Number(t.slice(3, 5)) : null;

function isValidHHMM(t: string) {
  if (!/^\d{2}:\d{2}$/.test(t)) return false;
  const m = toMin(t);
  return m !== null && m >= 0 && m < 24 * 60;
}

// Firestore does NOT allow `undefined`. Remove undefined keys before setDoc.
function stripUndefined<T extends Record<string, any>>(obj: T): Partial<T> {
  const out: any = {};
  for (const [k, v] of Object.entries(obj)) {
    if (v !== undefined) out[k] = v;
  }
  return out;
}

function calcMeals(r: RecordRow) {
  const i = toMin(r.inTime); // if inTime is "" => toMin("") returns null
  const o = toMin(r.outTime) ?? 24 * 60;

  // If no valid inTime, do NOT auto-calc (return as-is)
  if (i == null) return r;

  const bS = toMin(MEALS.breakfast.start)!;
  const bE = toMin(MEALS.breakfast.end)!;

  const at = (t: string) => {
    const m = toMin(t)!;
    return i <= m && o >= m;
  };

  return {
    ...r,
    breakfast: i <= bE && o >= bS ? 1 : 0,
    amSnack: at(MEALS.amSnack) ? 1 : 0,
    lunch: at(MEALS.lunch) ? 1 : 0,
    pmSnack: at(MEALS.pmSnack) ? 1 : 0,
  };
}

export default function App() {
  const [user, setUser] = useState<User | null>(null);
  const [date, setDate] = useState(today);
  const [kids, setKids] = useState<Kid[]>([]);
  const [records, setRecords] = useState<RecordRow[]>([]);
  const [newKid, setNewKid] = useState("");

  // manual edit UI state
  const [editingKidId, setEditingKidId] = useState<string | null>(null);
  const [editIn, setEditIn] = useState("");
  const [editOut, setEditOut] = useState("");
  const [editReason, setEditReason] = useState("");

  // UX status
  const [saveStatus, setSaveStatus] = useState<string>("");

  // auth listener
  useEffect(() => onAuthStateChanged(auth, setUser), []);

  // live sync kids + records
  useEffect(() => {
    if (!user) return;

    const kidsCol = collection(db, "users", user.uid, "kids");
    const unsubKids = onSnapshot(query(kidsCol, orderBy("name")), (snap) => {
      setKids(snap.docs.map((d) => d.data() as Kid));
    });

    const recCol = collection(db, "users", user.uid, "records");
    const unsubRecs = onSnapshot(query(recCol, orderBy("date")), (snap) => {
      setRecords(snap.docs.map((d) => d.data() as RecordRow));
    });

    return () => {
      unsubKids();
      unsubRecs();
    };
  }, [user]);

  async function addKid() {
    if (!user) return;
    const name = newKid.trim();
    if (!name) return;

    const id = crypto.randomUUID();
    const kid: Kid = { id, name, active: true };
    await setDoc(doc(db, "users", user.uid, "kids", id), kid);
    setNewKid("");
  }

  // Update OR Insert record for this kid+date
  async function upsertRecord(kid: Kid, patch: Partial<RecordRow>) {
    if (!user) return;

    const id = `${date}_${kid.id}`;
    const ref = doc(db, "users", user.uid, "records", id);
    const existing = await getDoc(ref);

    const base: RecordRow = existing.exists()
      ? (existing.data() as RecordRow)
      : {
          id,
          date,
          kidId: kid.id,
          kidName: kid.name,
          inTime: "",
          outTime: "",
          breakfast: 0,
          amSnack: 0,
          lunch: 0,
          pmSnack: 0,
          source: "auto",
          editReason: "",
        };

    // remove undefined keys (Firestore rejects undefined)
    const cleanedPatch = stripUndefined(patch);

    // merge + recalc meals (if inTime is "", calcMeals returns unchanged)
    const merged: RecordRow = calcMeals({
      ...base,
      ...(cleanedPatch as any),
      updatedAt: serverTimestamp(),
    });

    await setDoc(ref, stripUndefined(merged) as any);
  }

  async function checkIn(kid: Kid) {
    try {
      const now = new Date().toTimeString().slice(0, 5);
      await upsertRecord(kid, {
        inTime: now,
        source: "auto",
        editedBy: user?.uid,
        editReason: "Check-in button",
      });
    } catch (e) {
      console.error("CHECK IN FAILED:", e);
      alert("Check-in failed. See console for error.");
    }
  }

  async function checkOut(kid: Kid) {
    try {
      const now = new Date().toTimeString().slice(0, 5);
      await upsertRecord(kid, {
        outTime: now,
        source: "auto",
        editedBy: user?.uid,
        editReason: "Check-out button",
      });
    } catch (e) {
      console.error("CHECK OUT FAILED:", e);
      alert("Check-out failed. See console for error.");
    }
  }

  async function clearTimes(kid: Kid) {
    try {
      setSaveStatus("Clearing…");

      // Clear times by setting "" and explicitly zero meals
      await upsertRecord(kid, {
        inTime: "",
        outTime: "",
        breakfast: 0,
        amSnack: 0,
        lunch: 0,
        pmSnack: 0,
        source: "manual",
        editedBy: user?.uid,
        editReason: "Cleared times",
      });

      setSaveStatus("Cleared ✓");
      setTimeout(() => setSaveStatus(""), 1500);
    } catch (e) {
      console.error("CLEAR TIMES FAILED:", e);
      setSaveStatus("");
      alert("Clear failed. See console for error.");
    }
  }

  async function saveManualTimes(kid: Kid) {
    try {
      setSaveStatus("Saving…");

      const inTrim = editIn.trim();
      const outTrim = editOut.trim();
      const reasonTrim = editReason.trim();

      if (!inTrim || !isValidHHMM(inTrim)) {
        setSaveStatus("");
        alert("Please enter a valid In time (HH:MM).");
        return;
      }
      if (outTrim && !isValidHHMM(outTrim)) {
        setSaveStatus("");
        alert("Out time must be blank or a valid HH:MM.");
        return;
      }
      if (outTrim && toMin(outTrim)! < toMin(inTrim)!) {
        setSaveStatus("");
        alert("Out time cannot be earlier than In time.");
        return;
      }

      // outTime becomes "" when blank
      const patch: Partial<RecordRow> = {
        inTime: inTrim,
        outTime: outTrim || "",
        source: "manual",
        editedBy: user?.uid,
      };

      // only include editReason if they typed one (avoid undefined)
      if (reasonTrim) patch.editReason = reasonTrim;

      await upsertRecord(kid, patch);

      setSaveStatus("Saved ✓");
      setEditingKidId(null);
      setTimeout(() => setSaveStatus(""), 1500);
    } catch (e) {
      console.error("SAVE MANUAL TIMES FAILED:", e);
      setSaveStatus("");
      alert("Save failed. See console for error.");
    }
  }

  function exportExcel() {
    const ws = XLSX.utils.json_to_sheet(records);
    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, ws, "Records");
    XLSX.writeFile(wb, "daycare.xlsx");
  }

  const todaysKids = useMemo(() => kids.filter((k) => k.active), [kids]);

  const recMap = useMemo(() => {
    const m = new Map<string, RecordRow>();
    for (const r of records) m.set(r.id, r);
    return m;
  }, [records]);

  if (!user) {
    return (
      <div style={{ padding: 20, fontFamily: "sans-serif" }}>
        <h2>Daycare Check-In</h2>
        <button onClick={() => signInWithPopup(auth, provider)}>
          Sign in with Google
        </button>
      </div>
    );
  }

  return (
    <div style={{ padding: 20, fontFamily: "sans-serif" }}>
      <div style={{ display: "flex", gap: 10, alignItems: "center" }}>
        <h2 style={{ margin: 0 }}>Daycare Check-In</h2>
        <div
          style={{
            marginLeft: "auto",
            display: "flex",
            gap: 10,
            alignItems: "center",
          }}
        >
          {saveStatus ? (
            <span style={{ fontSize: 12, opacity: 0.8 }}>{saveStatus}</span>
          ) : null}
          <button onClick={() => signOut(auth)}>Sign out</button>
        </div>
      </div>

      <div style={{ marginTop: 10 }}>
        <input
          type="date"
          value={date}
          onChange={(e) => {
            setDate(e.target.value);
            setEditingKidId(null);
            setSaveStatus("");
          }}
        />
      </div>

      <h3>Kids</h3>
      <input
        placeholder="Add kid"
        value={newKid}
        onChange={(e) => setNewKid(e.target.value)}
      />
      <button onClick={addKid}>Add</button>

      <hr />

      {todaysKids.map((k) => {
        const r = recMap.get(`${date}_${k.id}`);
        const isEditing = editingKidId === k.id;

        return (
          <div
            key={k.id}
            style={{
              marginBottom: 12,
              padding: 10,
              border: "1px solid #eee",
              borderRadius: 8,
            }}
          >
            <div
              style={{
                display: "flex",
                gap: 8,
                alignItems: "center",
                flexWrap: "wrap",
              }}
            >
              <b style={{ fontSize: 16 }}>{k.name}</b>

              <button onClick={() => checkIn(k)}>Check In</button>
              <button onClick={() => checkOut(k)}>Check Out</button>

              <button
                onClick={() => {
                  setEditingKidId(k.id);
                  setEditIn(r?.inTime ?? "");
                  setEditOut(r?.outTime ?? "");
                  setEditReason("");
                  setSaveStatus("");
                }}
              >
                Edit Times
              </button>

              {(r?.inTime || r?.outTime) && (
                <button onClick={() => clearTimes(k)}>Clear</button>
              )}
            </div>

            <div style={{ marginTop: 6 }}>
              In: {r?.inTime || "-"} | Out: {r?.outTime || "-"} | B:
              {r?.breakfast || 0} AM:{r?.amSnack || 0} L:{r?.lunch || 0} PM:
              {r?.pmSnack || 0}
              {r?.source ? (
                <span style={{ marginLeft: 10, opacity: 0.7 }}>
                  (source: {r.source})
                </span>
              ) : null}
            </div>

            {isEditing && (
              <div
                style={{
                  marginTop: 10,
                  display: "flex",
                  gap: 10,
                  flexWrap: "wrap",
                  alignItems: "center",
                }}
              >
                <label
                  style={{
                    display: "flex",
                    gap: 6,
                    alignItems: "center",
                  }}
                >
                  In:
                  <input
                    type="time"
                    value={editIn}
                    onChange={(e) => setEditIn(e.target.value)}
                    style={{ padding: 6 }}
                  />
                </label>

                <label
                  style={{
                    display: "flex",
                    gap: 6,
                    alignItems: "center",
                  }}
                >
                  Out:
                  <input
                    type="time"
                    value={editOut}
                    onChange={(e) => setEditOut(e.target.value)}
                    style={{ padding: 6 }}
                  />
                </label>

                <input
                  placeholder="Reason (optional)"
                  value={editReason}
                  onChange={(e) => setEditReason(e.target.value)}
                  style={{ padding: 6, minWidth: 220 }}
                />

                <button onClick={async () => await saveManualTimes(k)}>
                  Save
                </button>
                <button
                  onClick={() => {
                    setEditingKidId(null);
                    setSaveStatus("");
                  }}
                >
                  Cancel
                </button>
              </div>
            )}
          </div>
        );
      })}

      <hr />
      <button onClick={exportExcel}>Export Excel</button>
    </div>
  );
}


