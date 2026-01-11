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
  updateDoc,
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
  inTime?: string; // "HH:MM" or ""
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

type ReimbursementRates = {
  year: number;
  breakfast: number; // dollars
  snack: number; // dollars (used for amSnack + pmSnack)
  lunch: number; // dollars
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

const yearFromDate = (d: string) => Number(d.slice(0, 4));
const monthFromDate = (d: string) => d.slice(0, 7); // YYYY-MM

const round2 = (n: number) => Math.round(n * 100) / 100;

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

  // reimbursement rates (by year)
  const [ratesByYear, setRatesByYear] = useState<
    Record<number, ReimbursementRates>
  >({});
  const [ratesYear, setRatesYear] = useState<number>(new Date().getFullYear());
  const [rateBreakfast, setRateBreakfast] = useState<string>("0");
  const [rateSnack, setRateSnack] = useState<string>("0");
  const [rateLunch, setRateLunch] = useState<string>("0");
  const [ratesStatus, setRatesStatus] = useState<string>("");

  // auth listener
  useEffect(() => onAuthStateChanged(auth, setUser), []);

  // live sync kids + records + reimbursement rates
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

    // users/{uid}/settings/config/reimbursementRates/{year}
    const ratesCol = collection(
      db,
      "users",
      user.uid,
      "settings",
      "config",
      "reimbursementRates"
    );
    const unsubRates = onSnapshot(query(ratesCol, orderBy("year")), (snap) => {
      const map: Record<number, ReimbursementRates> = {};
      for (const d of snap.docs) {
        const r = d.data() as ReimbursementRates;
        map[r.year] = r;
      }
      setRatesByYear(map);
    });

    return () => {
      unsubKids();
      unsubRecs();
      unsubRates();
    };
  }, [user]);

  // when changing selected year, populate inputs from saved rates (if exist)
  useEffect(() => {
    const r = ratesByYear[ratesYear];
    if (r) {
      setRateBreakfast(String(r.breakfast ?? 0));
      setRateSnack(String(r.snack ?? 0));
      setRateLunch(String(r.lunch ?? 0));
    } else {
      setRateBreakfast("0");
      setRateSnack("0");
      setRateLunch("0");
    }
  }, [ratesYear, ratesByYear]);

  async function addKid() {
    if (!user) return;
    const name = newKid.trim();
    if (!name) return;

    const id = crypto.randomUUID();
    const kid: Kid = { id, name, active: true };
    await setDoc(doc(db, "users", user.uid, "kids", id), kid);
    setNewKid("");
  }

  // ✅ NEW: deactivate kid (hide from list, keep history)
  async function deactivateKid(kid: Kid) {
    if (!user) return;

    const ok = confirm(
      `Deactivate ${kid.name}? They will be hidden from the list, but history will remain.`
    );
    if (!ok) return;

    const ref = doc(db, "users", user.uid, "kids", kid.id);
    await updateDoc(ref, { active: false });
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

  async function saveRatesForYear() {
    if (!user) return;
    setRatesStatus("Saving…");

    const y = Number(ratesYear);
    const b = Number(rateBreakfast);
    const s = Number(rateSnack);
    const l = Number(rateLunch);

    const isBad =
      !Number.isFinite(y) ||
      y < 2000 ||
      y > 2100 ||
      !Number.isFinite(b) ||
      b < 0 ||
      !Number.isFinite(s) ||
      s < 0 ||
      !Number.isFinite(l) ||
      l < 0;

    if (isBad) {
      setRatesStatus("");
      alert("Please enter valid non-negative numbers for rates and a valid year.");
      return;
    }

    const ref = doc(
      db,
      "users",
      user.uid,
      "settings",
      "config",
      "reimbursementRates",
      String(y)
    );

    const payload: ReimbursementRates = {
      year: y,
      breakfast: round2(b),
      snack: round2(s),
      lunch: round2(l),
      updatedAt: serverTimestamp(),
    };

    try {
      await setDoc(ref, payload);
      setRatesStatus("Saved ✓");
      setTimeout(() => setRatesStatus(""), 1500);
    } catch (e) {
      console.error("SAVE RATES FAILED:", e);
      setRatesStatus("");
      alert("Saving reimbursement rates failed. See console for error.");
    }
  }

  // pick best available rates for a given year:
  // - exact year if exists
  // - otherwise nearest prior year
  // - otherwise zeros
  const getRatesForYear = (y: number): ReimbursementRates => {
    const exact = ratesByYear[y];
    if (exact) return exact;

    const years = Object.keys(ratesByYear)
      .map(Number)
      .filter((n) => Number.isFinite(n))
      .sort((a, b) => a - b);

    let best: number | null = null;
    for (const yr of years) {
      if (yr <= y) best = yr;
      else break;
    }

    if (best != null) return ratesByYear[best];

    return { year: y, breakfast: 0, snack: 0, lunch: 0 };
  };

  // reimbursement summaries
  const monthlySummary = useMemo(() => {
    type Row = {
      month: string; // YYYY-MM
      year: number;
      breakfasts: number;
      snacks: number;
      lunches: number;
      total: number;
      rateYearUsed: number;
    };

    const map = new Map<string, Row>();

    for (const r of records) {
      const month = monthFromDate(r.date);
      const year = yearFromDate(r.date);
      const rates = getRatesForYear(year);

      const breakfasts = r.breakfast || 0;
      const snacks = (r.amSnack || 0) + (r.pmSnack || 0);
      const lunches = r.lunch || 0;

      const amount =
        breakfasts * (rates.breakfast || 0) +
        snacks * (rates.snack || 0) +
        lunches * (rates.lunch || 0);

      const cur = map.get(month) || {
        month,
        year,
        breakfasts: 0,
        snacks: 0,
        lunches: 0,
        total: 0,
        rateYearUsed: rates.year,
      };

      cur.breakfasts += breakfasts;
      cur.snacks += snacks;
      cur.lunches += lunches;
      cur.total += amount;

      map.set(month, cur);
    }

    return Array.from(map.values())
      .sort((a, b) => a.month.localeCompare(b.month))
      .map((r) => ({
        ...r,
        total: round2(r.total),
      }));
  }, [records, ratesByYear]);

  const annualSummary = useMemo(() => {
    type Row = {
      year: number;
      breakfasts: number;
      snacks: number;
      lunches: number;
      total: number;
      rateYearUsed: number;
    };

    const map = new Map<number, Row>();

    for (const r of records) {
      const year = yearFromDate(r.date);
      const rates = getRatesForYear(year);

      const breakfasts = r.breakfast || 0;
      const snacks = (r.amSnack || 0) + (r.pmSnack || 0);
      const lunches = r.lunch || 0;

      const amount =
        breakfasts * (rates.breakfast || 0) +
        snacks * (rates.snack || 0) +
        lunches * (rates.lunch || 0);

      const cur = map.get(year) || {
        year,
        breakfasts: 0,
        snacks: 0,
        lunches: 0,
        total: 0,
        rateYearUsed: rates.year,
      };

      cur.breakfasts += breakfasts;
      cur.snacks += snacks;
      cur.lunches += lunches;
      cur.total += amount;
      cur.rateYearUsed = rates.year;

      map.set(year, cur);
    }

    return Array.from(map.values())
      .sort((a, b) => a.year - b.year)
      .map((r) => ({
        ...r,
        total: round2(r.total),
      }));
  }, [records, ratesByYear]);

  function exportExcel() {
    // Records tab: include a computed reimbursement column (based on record date year)
    const recordsWithReimb = records.map((r) => {
      const y = yearFromDate(r.date);
      const rates = getRatesForYear(y);
      const breakfasts = r.breakfast || 0;
      const snacks = (r.amSnack || 0) + (r.pmSnack || 0);
      const lunches = r.lunch || 0;

      const reimbursement =
        breakfasts * (rates.breakfast || 0) +
        snacks * (rates.snack || 0) +
        lunches * (rates.lunch || 0);

      return {
        ...r,
        snacks,
        reimbursement: round2(reimbursement),
        rateYearUsed: rates.year,
      };
    });

    const ws1 = XLSX.utils.json_to_sheet(recordsWithReimb);
    const ws2 = XLSX.utils.json_to_sheet(monthlySummary);
    const ws3 = XLSX.utils.json_to_sheet(annualSummary);

    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, ws1, "Records");
    XLSX.utils.book_append_sheet(wb, ws2, "Monthly Summary");
    XLSX.utils.book_append_sheet(wb, ws3, "Annual Summary");
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

      {/* CLOCK-IN/CLOCK-OUT FIRST */}
      <div style={{ marginTop: 14 }}>
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

                {/* ✅ NEW BUTTON */}
                <button
                  onClick={() => deactivateKid(k)}
                  title="Hide from list but keep history"
                  style={{ color: "#a00" }}
                >
                  Deactivate
                </button>
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
      </div>

      {/* ADD KID AREA */}
      <div style={{ marginTop: 6 }}>
        <h3 style={{ margin: "10px 0 6px" }}>Kids</h3>
        <input
          placeholder="Add kid"
          value={newKid}
          onChange={(e) => setNewKid(e.target.value)}
        />
        <button onClick={addKid} style={{ marginLeft: 6 }}>
          Add
        </button>
      </div>

      {/* RATES */}
      <div
        style={{
          marginTop: 16,
          padding: 12,
          border: "1px solid #eee",
          borderRadius: 8,
        }}
      >
        <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
          <h3 style={{ margin: 0 }}>Reimbursement Rates</h3>
          {ratesStatus ? (
            <span style={{ fontSize: 12, opacity: 0.8 }}>{ratesStatus}</span>
          ) : null}
        </div>

        <div
          style={{
            marginTop: 10,
            display: "flex",
            gap: 12,
            flexWrap: "wrap",
          }}
        >
          <label style={{ display: "flex", gap: 6, alignItems: "center" }}>
            Year:
            <input
              type="number"
              value={ratesYear}
              onChange={(e) => setRatesYear(Number(e.target.value))}
              style={{ padding: 6, width: 110 }}
            />
          </label>

          <label style={{ display: "flex", gap: 6, alignItems: "center" }}>
            Breakfast ($):
            <input
              type="number"
              step="0.01"
              value={rateBreakfast}
              onChange={(e) => setRateBreakfast(e.target.value)}
              style={{ padding: 6, width: 120 }}
            />
          </label>

          <label style={{ display: "flex", gap: 6, alignItems: "center" }}>
            Snack ($):
            <input
              type="number"
              step="0.01"
              value={rateSnack}
              onChange={(e) => setRateSnack(e.target.value)}
              style={{ padding: 6, width: 120 }}
            />
          </label>

          <label style={{ display: "flex", gap: 6, alignItems: "center" }}>
            Lunch ($):
            <input
              type="number"
              step="0.01"
              value={rateLunch}
              onChange={(e) => setRateLunch(e.target.value)}
              style={{ padding: 6, width: 120 }}
            />
          </label>

          <button onClick={saveRatesForYear}>Save Rates</button>
        </div>

        <div style={{ marginTop: 8, fontSize: 12, opacity: 0.75 }}>
          Tip: These rates apply automatically based on each record’s date year.
          If a year is missing, the app uses the most recent prior year’s rates.
        </div>
      </div>

      {/* SUMMARY */}
      <div
        style={{
          marginTop: 16,
          padding: 12,
          border: "1px solid #eee",
          borderRadius: 8,
        }}
      >
        <h3 style={{ marginTop: 0 }}>Reimbursement Summary</h3>

        <div style={{ marginTop: 8 }}>
          <b>Annual</b>
          <div style={{ overflowX: "auto", marginTop: 6 }}>
            <table style={{ borderCollapse: "collapse", width: "100%" }}>
              <thead>
                <tr>
                  {["Year", "Breakfasts", "Snacks", "Lunches", "Total ($)"].map(
                    (h) => (
                      <th
                        key={h}
                        style={{
                          textAlign: "left",
                          borderBottom: "1px solid #eee",
                          padding: "6px 8px",
                          fontSize: 13,
                        }}
                      >
                        {h}
                      </th>
                    )
                  )}
                </tr>
              </thead>
              <tbody>
                {annualSummary.length === 0 ? (
                  <tr>
                    <td style={{ padding: "8px" }} colSpan={5}>
                      No data yet.
                    </td>
                  </tr>
                ) : (
                  annualSummary.map((r) => (
                    <tr key={r.year}>
                      <td style={{ padding: "6px 8px" }}>{r.year}</td>
                      <td style={{ padding: "6px 8px" }}>{r.breakfasts}</td>
                      <td style={{ padding: "6px 8px" }}>{r.snacks}</td>
                      <td style={{ padding: "6px 8px" }}>{r.lunches}</td>
                      <td style={{ padding: "6px 8px" }}>
                        {r.total.toFixed(2)}
                      </td>
                    </tr>
                  ))
                )}
              </tbody>
            </table>
          </div>
        </div>

        <div style={{ marginTop: 14 }}>
          <b>Monthly</b>
          <div style={{ overflowX: "auto", marginTop: 6 }}>
            <table style={{ borderCollapse: "collapse", width: "100%" }}>
              <thead>
                <tr>
                  {["Month", "Breakfasts", "Snacks", "Lunches", "Total ($)"].map(
                    (h) => (
                      <th
                        key={h}
                        style={{
                          textAlign: "left",
                          borderBottom: "1px solid #eee",
                          padding: "6px 8px",
                          fontSize: 13,
                        }}
                      >
                        {h}
                      </th>
                    )
                  )}
                </tr>
              </thead>
              <tbody>
                {monthlySummary.length === 0 ? (
                  <tr>
                    <td style={{ padding: "8px" }} colSpan={5}>
                      No data yet.
                    </td>
                  </tr>
                ) : (
                  monthlySummary.map((r) => (
                    <tr key={r.month}>
                      <td style={{ padding: "6px 8px" }}>{r.month}</td>
                      <td style={{ padding: "6px 8px" }}>{r.breakfasts}</td>
                      <td style={{ padding: "6px 8px" }}>{r.snacks}</td>
                      <td style={{ padding: "6px 8px" }}>{r.lunches}</td>
                      <td style={{ padding: "6px 8px" }}>
                        {r.total.toFixed(2)}
                      </td>
                    </tr>
                  ))
                )}
              </tbody>
            </table>
          </div>
        </div>
      </div>

      <hr />
      <button onClick={exportExcel}>Export Excel (Records + Summaries)</button>
    </div>
  );
}

