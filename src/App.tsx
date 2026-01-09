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
  inTime?: string;
  outTime?: string;
  breakfast: number;
  amSnack: number;
  lunch: number;
  pmSnack: number;
  updatedAt?: any;
};

const MEALS = {
  breakfast: { start: "09:00", end: "09:30" },
  amSnack: "11:00",
  lunch: "13:00",
  pmSnack: "15:00",
};

const today = () => new Date().toISOString().slice(0, 10);
const toMin = (t?: string) => (t ? Number(t.slice(0, 2)) * 60 + Number(t.slice(3, 5)) : null);

function calcMeals(r: RecordRow) {
  const i = toMin(r.inTime);
  const o = toMin(r.outTime) ?? 24 * 60;
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
          breakfast: 0,
          amSnack: 0,
          lunch: 0,
          pmSnack: 0,
        };

    const merged = calcMeals({ ...base, ...patch, updatedAt: serverTimestamp() });
    await setDoc(ref, merged);
  }

  async function checkIn(kid: Kid) {
    const now = new Date().toTimeString().slice(0, 5);
    await upsertRecord(kid, { inTime: now });
  }

  async function checkOut(kid: Kid) {
    const now = new Date().toTimeString().slice(0, 5);
    await upsertRecord(kid, { outTime: now });
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
        <button onClick={() => signInWithPopup(auth, provider)}>Sign in with Google</button>
      </div>
    );
  }

  return (
    <div style={{ padding: 20, fontFamily: "sans-serif" }}>
      <div style={{ display: "flex", gap: 10, alignItems: "center" }}>
        <h2 style={{ margin: 0 }}>Daycare Check-In</h2>
        <div style={{ marginLeft: "auto" }}>
          <button onClick={() => signOut(auth)}>Sign out</button>
        </div>
      </div>

      <div style={{ marginTop: 10 }}>
        <input type="date" value={date} onChange={(e) => setDate(e.target.value)} />
      </div>

      <h3>Kids</h3>
      <input placeholder="Add kid" value={newKid} onChange={(e) => setNewKid(e.target.value)} />
      <button onClick={addKid}>Add</button>

      <hr />

      {todaysKids.map((k) => {
        const r = recMap.get(`${date}_${k.id}`);
        return (
          <div key={k.id} style={{ marginBottom: 10 }}>
            <b>{k.name}</b>{" "}
            <button onClick={() => checkIn(k)}>Check In</button>{" "}
            <button onClick={() => checkOut(k)}>Check Out</button>
            <div>
              In: {r?.inTime || "-"} | Out: {r?.outTime || "-"} | B:{r?.breakfast || 0} AM:
              {r?.amSnack || 0} L:{r?.lunch || 0} PM:{r?.pmSnack || 0}
            </div>
          </div>
        );
      })}

      <hr />
      <button onClick={exportExcel}>Export Excel</button>
    </div>
  );
}
