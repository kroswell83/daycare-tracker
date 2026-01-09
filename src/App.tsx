import { useEffect, useState } from "react";
import * as XLSX from "xlsx";

type Kid = {
  id: string;
  name: string;
  active: boolean;
};

type RecordRow = {
  date: string;
  kidId: string;
  kidName: string;
  inTime?: string;
  outTime?: string;
  breakfast: number;
  amSnack: number;
  lunch: number;
  pmSnack: number;
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

export default function App() {
  const [date, setDate] = useState(today);
  const [kids, setKids] = useState<Kid[]>(() =>
    JSON.parse(localStorage.getItem("kids") || "[]")
  );
  const [records, setRecords] = useState<RecordRow[]>(() =>
    JSON.parse(localStorage.getItem("records") || "[]")
  );
  const [newKid, setNewKid] = useState("");

  useEffect(() => {
    localStorage.setItem("kids", JSON.stringify(kids));
    localStorage.setItem("records", JSON.stringify(records));
  }, [kids, records]);

  function getRecord(kid: Kid) {
    let r = records.find((x) => x.date === date && x.kidId === kid.id);
    if (!r) {
      r = {
        date,
        kidId: kid.id,
        kidName: kid.name,
        breakfast: 0,
        amSnack: 0,
        lunch: 0,
        pmSnack: 0,
      };
      setRecords((p) => [...p, r!]);
    }
    return r;
  }

  function calcMeals(r: RecordRow) {
    const i = toMin(r.inTime);
    const o = toMin(r.outTime) ?? 24 * 60;
    if (i == null) return r;

    const bS = toMin(MEALS.breakfast.start)!;
    const bE = toMin(MEALS.breakfast.end)!;

    return {
      ...r,
      breakfast: i <= bE && o >= bS ? 1 : 0,
      amSnack: i <= toMin(MEALS.amSnack)! && o >= toMin(MEALS.amSnack)! ? 1 : 0,
      lunch: i <= toMin(MEALS.lunch)! && o >= toMin(MEALS.lunch)! ? 1 : 0,
      pmSnack: i <= toMin(MEALS.pmSnack)! && o >= toMin(MEALS.pmSnack)! ? 1 : 0,
    };
  }

  function checkIn(kid: Kid) {
    const r = getRecord(kid);
    r.inTime = new Date().toTimeString().slice(0, 5);
    setRecords((p) => p.map((x) => (x === r ? calcMeals(r) : x)));
  }

  function checkOut(kid: Kid) {
    const r = getRecord(kid);
    r.outTime = new Date().toTimeString().slice(0, 5);
    setRecords((p) => p.map((x) => (x === r ? calcMeals(r) : x)));
  }

  function exportExcel() {
    const ws = XLSX.utils.json_to_sheet(records);
    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, ws, "Records");
    XLSX.writeFile(wb, "daycare.xlsx");
  }

  const todays = kids.filter((k) => k.active);

  return (
    <div style={{ padding: 20, fontFamily: "sans-serif" }}>
      <h2>Daycare Check-In</h2>

      <input type="date" value={date} onChange={(e) => setDate(e.target.value)} />

      <h3>Kids</h3>
      <input
        placeholder="Add kid"
        value={newKid}
        onChange={(e) => setNewKid(e.target.value)}
      />
      <button
        onClick={() => {
          setKids([...kids, { id: crypto.randomUUID(), name: newKid, active: true }]);
          setNewKid("");
        }}
      >
        Add
      </button>

      <hr />

      {todays.map((k) => {
        const r = records.find((x) => x.date === date && x.kidId === k.id);
        return (
          <div key={k.id} style={{ marginBottom: 10 }}>
            <b>{k.name}</b>{" "}
            <button onClick={() => checkIn(k)}>Check In</button>{" "}
            <button onClick={() => checkOut(k)}>Check Out</button>
            <div>
              In: {r?.inTime || "-"} | Out: {r?.outTime || "-"} | B:
              {r?.breakfast || 0} AM:{r?.amSnack || 0} L:{r?.lunch || 0} PM:
              {r?.pmSnack || 0}
            </div>
          </div>
        );
      })}

      <hr />
      <button onClick={exportExcel}>Export Excel</button>
    </div>
  );
}
