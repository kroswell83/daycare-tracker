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

const COLORS = {
  bgPage: "#f7f9fb",
  card: "#ffffff",
  border: "#e3e7ee",

  header: "#0f172a",
  muted: "#64748b",

  primary: "#2563eb", // blue
  success: "#16a34a", // green
  danger: "#dc2626", // red
  warning: "#f59e0b", // amber

  infoBg: "#e0f2fe",
  infoText: "#0369a1",
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

function buttonStyle(variant: "primary" | "success" | "danger" | "warning" | "neutral") {
  const base: React.CSSProperties = {
    padding: "8px 10px",
    borderRadius: 8,
    border: `1px solid ${COLORS.border}`,
    cursor: "pointer",
    fontWeight: 600,
    fontSize: 13,
    lineHeight: 1,
  };

  if (variant === "primary")
    return { ...base, background: COLORS.primary, color: "#fff", border: "1px solid transparent" };
  if (variant === "success")
    return { ...base, background: COLORS.success, color: "#fff", border: "1px solid transparent" };
  if (variant === "danger")
    return { ...base, background: COLORS.danger, color: "#fff", border: "1px solid transparent" };
  if (variant === "warning")
    return { ...base, background: "#fde68a", color: "#111827", border: `1px solid #f59e0b` };
  return { ...base, background: "#ffffff", color: COLORS.header };
}

function cardStyle(extra?: React.CSSProperties): React.CSSProperties {
  return {
    background: COLORS.card,
    border: `1px solid ${COLORS.border}`,
    borderRadius: 12,
    padding: 12,
    boxShadow: "0 1px 2px rgba(0,0,0,0.04)",
    ...extra,
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

  // Deactivate kid (hide from list, keep history)
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

    const cleanedPatch = stripUndefined(patch);

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

      const patch: Partial<RecordRow> = {
        inTime: inTrim,
        outTime: outTrim || "",
        source: "manual",
        editedBy: user?.uid,
      };

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
      .map((r) => ({ ...r, total: round2(r.total) }));
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
      .map((r) => ({ ...r, total: round2(r.total) }));
  }, [records, ratesByYear]);

  function exportExcel() {
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
      <div style={{ padding: 20, fontFamily: "sans-serif", background: COLORS.bgPage, minHeight: "100vh" }}>
        <h2 style={{ color: COLORS.header }}>Daycare Check-In</h2>
        <button style={buttonStyle("primary")} onClick={() => signInWithPopup(auth, provider)}>
          Sign in with Google
        </button>
      </div>
    );
  }

  return (
    <div
      style={{
        padding: 20,
        fontFamily: "sans-serif",
        background: COLORS.bgPage,
        minHeight: "100vh",
      }}
    >
      <div style={{ display: "flex", gap: 10, alignItems: "center" }}>
        <h2 style={{ margin: 0, color: COLORS.header }}>Daycare Check-In</h2>
        <div
          style={{
            marginLeft: "auto",
            display: "flex",
            gap: 10,
            alignItems: "center",
          }}
        >
          {saveStatus ? (
            <span
              style={{
                fontSize: 12,
                padding: "4px 8px",
                borderRadius: 8,
                background: COLORS.infoBg,
                color: COLORS.infoText,
                border: `1px solid ${COLORS.border}`,
              }}
            >
              {saveStatus}
            </span>
          ) : null}
          <button style={buttonStyle("neutral")} onClick={() => signOut(auth)}>
            Sign out
          </button>
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
          style={{
            padding: 8,
            borderRadius: 10,
            border: `1px solid ${COLORS.border}`,
            background: "#fff",
          }}
        />
      </div>

      {/* CLOCK-IN/CLOCK-OUT FIRST */}
      <div style={{ marginTop: 14 }}>
        {todaysKids.map((k) => {
          const r = recMap.get(`${date}_${k.id}`);
          const isEditing = editingKidId === k.id;

          return (
            <div key={k.id} style={cardStyle({ marginBottom: 12 })}>
              <div
                style={{
                  display: "flex",
                  gap: 8,
                  alignItems: "center",
                  flexWrap: "wrap",
                }}
              >
                <b style={{ fontSize: 16, color: COLORS.header }}>{k.name}</b>

                <button style={buttonStyle("success")} onClick={() => checkIn(k)}>
                  Check In
                </button>
                <button style={buttonStyle("danger")} onClick={() => checkOut(k)}>
                  Check Out
                </button>

                <button
                  style={buttonStyle("warning")}
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
                  <button style={buttonStyle("neutral")} onClick={() => clearTimes(k)}>
                    Clear
                  </button>
                )}

                <button
                  onClick={() => deactivateKid(k)}
                  title="Hide from list but keep history"
                  style={{
                    padding: "8px 10px",
                    borderRadius: 8,
                    cursor: "pointer",
                    fontWeight: 700,
                    fontSize: 13,
                    background: "#fee2e2",
                    color: COLORS.danger,
                    border: `1px solid ${COLORS.danger}`,
                  }}
                >
                  Deactivate
                </button>
              </div>

              <div style={{ marginTop: 8, color: COLORS.muted, fontSize: 13 }}>
                <span style={{ color: COLORS.header, fontWeight: 600 }}>In:</span>{" "}
                {r?.inTime || "-"}{" "}
                <span style={{ color: COLORS.header, fontWeight: 600 }}>Out:</span>{" "}
                {r?.outTime || "-"}{" "}
                <span style={{ marginLeft: 10 }}>
                  <span style={{ color: COLORS.header, fontWeight: 600 }}>Meals:</span>{" "}
                  B:{r?.breakfast || 0} AM:{r?.amSnack || 0} L:{r?.lunch || 0} PM:{r?.pmSnack || 0}
                </span>
                {r?.source ? (
                  <span style={{ marginLeft: 10, opacity: 0.8 }}>
                    (source: {r.source})
                  </span>
                ) : null}
              </div>

              {isEditing && (
                <div
                  style={{
                    marginTop: 12,
                    display: "flex",
                    gap: 10,
                    flexWrap: "wrap",
                    alignItems: "center",
                    background: "#f8fafc",
                    border: `1px dashed ${COLORS.border}`,
                    padding: 10,
                    borderRadius: 12,
                  }}
                >
                  <label style={{ display: "flex", gap: 6, alignItems: "center", color: COLORS.header }}>
                    In:
                    <input
                      type="time"
                      value={editIn}
                      onChange={(e) => setEditIn(e.target.value)}
                      style={{
                        padding: 8,
                        borderRadius: 10,
                        border: `1px solid ${COLORS.border}`,
                        background: "#fff",
                      }}
                    />
                  </label>

                  <label style={{ display: "flex", gap: 6, alignItems: "center", color: COLORS.header }}>
                    Out:
                    <input
                      type="time"
                      value={editOut}
                      onChange={(e) => setEditOut(e.target.value)}
                      style={{
                        padding: 8,
                        borderRadius: 10,
                        border: `1px solid ${COLORS.border}`,
                        background: "#fff",
                      }}
                    />
                  </label>

                  <input
                    placeholder="Reason (optional)"
                    value={editReason}
                    onChange={(e) => setEditReason(e.target.value)}
                    style={{
                      padding: 8,
                      minWidth: 240,
                      borderRadius: 10,
                      border: `1px solid ${COLORS.border}`,
                      background: "#fff",
                    }}
                  />

                  <button style={buttonStyle("primary")} onClick={async () => await saveManualTimes(k)}>
                    Save
                  </button>
                  <button
                    style={buttonStyle("neutral")}
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
        <h3 style={{ margin: "10px 0 6px", color: COLORS.header }}>Kids</h3>
        <div style={{ display: "flex", gap: 8, flexWrap: "wrap", alignItems: "center" }}>
          <input
            placeholder="Add kid"
            value={newKid}
            onChange={(e) => setNewKid(e.target.value)}
            style={{
              padding: 10,
              borderRadius: 10,
              border: `1px solid ${COLORS.border}`,
              background: "#fff",
              minWidth: 220,
            }}
          />
          <button style={buttonStyle("primary")} onClick={addKid}>
            Add
          </button>
        </div>
      </div>

      {/* RATES UNDER "ADD KID" */}
      <div style={{ marginTop: 16, ...cardStyle() }}>
        <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
          <h3 style={{ margin: 0, color: COLORS.header }}>Reimbursement Rates</h3>
          {ratesStatus ? (
            <span
              style={{
                fontSize: 12,
                padding: "4px 8px",
                borderRadius: 8,
                background: COLORS.infoBg,
                color: COLORS.infoText,
                border: `1px solid ${COLORS.border}`,
              }}
            >
              {ratesStatus}
            </span>
          ) : null}
        </div>

        <div style={{ marginTop: 10, display: "flex", gap: 12, flexWrap: "wrap" }}>
          <label style={{ display: "flex", gap: 6, alignItems: "center", color: COLORS.header }}>
            Year:
            <input
              type="number"
              value={ratesYear}
              onChange={(e) => setRatesYear(Number(e.target.value))}
              style={{
                padding: 10,
                width: 120,
                borderRadius: 10,
                border: `1px solid ${COLORS.border}`,
                background: "#fff",
              }}
            />
          </label>

          <label style={{ display: "flex", gap: 6, alignItems: "center", color: COLORS.header }}>
            Breakfast ($):
            <input
              type="number"
              step="0.01"
              value={rateBreakfast}
              onChange={(e) => setRateBreakfast(e.target.value)}
              style={{
                padding: 10,
                width: 140,
                borderRadius: 10,
                border: `1px solid ${COLORS.border}`,
                background: "#fff",
              }}
            />
          </label>

          <label style={{ display: "flex", gap: 6, alignItems: "center", color: COLORS.header }}>
            Snack ($):
            <input
              type="number"
              step="0.01"
              value={rateSnack}
              onChange={(e) => setRateSnack(e.target.value)}
              style={{
                padding: 10,
                width: 140,
                borderRadius: 10,
                border: `1px solid ${COLORS.border}`,
                background: "#fff",
              }}
            />
          </label>

          <label style={{ display: "flex", gap: 6, alignItems: "center", color: COLORS.header }}>
            Lunch ($):
            <input
              type="number"
              step="0.01"
              value={rateLunch}
              onChange={(e) => setRateLunch(e.target.value)}
              style={{
                padding: 10,
                width: 140,
                borderRadius: 10,
                border: `1px solid ${COLORS.border}`,
                background: "#fff",
              }}
            />
          </label>

          <button style={buttonStyle("primary")} onClick={saveRatesForYear}>
            Save Rates
          </button>
        </div>

        <div style={{ marginTop: 8, fontSize: 12, color: COLORS.muted }}>
          Tip: Rates apply automatically based on each record’s year. Missing years use the most recent prior year’s rates.
        </div>
      </div>

      {/* SUMMARY */}
      <div style={{ marginTop: 16, ...cardStyle() }}>
        <h3 style={{ marginTop: 0, color: COLORS.header }}>Reimbursement Summary</h3>

        <div style={{ marginTop: 8 }}>
          <b style={{ color: COLORS.header }}>Annual</b>
          <div style={{ overflowX: "auto", marginTop: 6 }}>
            <table style={{ borderCollapse: "collapse", width: "100%" }}>
              <thead>
                <tr>
                  {["Year", "Breakfasts", "Snacks", "Lunches", "Total ($)"].map((h) => (
                    <th
                      key={h}
                      style={{
                        textAlign: "left",
                        borderBottom: `1px solid ${COLORS.border}`,
                        padding: "8px 10px",
                        fontSize: 13,
                        color: COLORS.muted,
                      }}
                    >
                      {h}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {annualSummary.length === 0 ? (
                  <tr>
                    <td style={{ padding: "10px", color: COLORS.muted }} colSpan={5}>
                      No data yet.
                    </td>
                  </tr>
                ) : (
                  annualSummary.map((r) => (
                    <tr key={r.year}>
                      <td style={{ padding: "8px 10px", color: COLORS.header, fontWeight: 700 }}>{r.year}</td>
                      <td style={{ padding: "8px 10px" }}>{r.breakfasts}</td>
                      <td style={{ padding: "8px 10px" }}>{r.snacks}</td>
                      <td style={{ padding: "8px 10px" }}>{r.lunches}</td>
                      <td style={{ padding: "8px 10px", fontWeight: 800 }}>
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
          <b style={{ color: COLORS.header }}>Monthly</b>
          <div style={{ overflowX: "auto", marginTop: 6 }}>
            <table style={{ borderCollapse: "collapse", width: "100%" }}>
              <thead>
                <tr>
                  {["Month", "Breakfasts", "Snacks", "Lunches", "Total ($)"].map((h) => (
                    <th
                      key={h}
                      style={{
                        textAlign: "left",
                        borderBottom: `1px solid ${COLORS.border}`,
                        padding: "8px 10px",
                        fontSize: 13,
                        color: COLORS.muted,
                      }}
                    >
                      {h}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {monthlySummary.length === 0 ? (
                  <tr>
                    <td style={{ padding: "10px", color: COLORS.muted }} colSpan={5}>
                      No data yet.
                    </td>
                  </tr>
                ) : (
                  monthlySummary.map((r) => (
                    <tr key={r.month}>
                      <td style={{ padding: "8px 10px", color: COLORS.header, fontWeight: 700 }}>{r.month}</td>
                      <td style={{ padding: "8px 10px" }}>{r.breakfasts}</td>
                      <td style={{ padding: "8px 10px" }}>{r.snacks}</td>
                      <td style={{ padding: "8px 10px" }}>{r.lunches}</td>
                      <td style={{ padding: "8px 10px", fontWeight: 800 }}>
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

      <div style={{ marginTop: 16 }}>
        <button style={buttonStyle("primary")} onClick={exportExcel}>
          Export Excel (Records + Summaries)
        </button>
      </div>
    </div>
  );
}

