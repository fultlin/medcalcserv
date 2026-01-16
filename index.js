const express = require("express");
const cors = require("cors");
const sqlite3 = require("sqlite3").verbose();
const session = require("express-session");
const path = require("path");

const app = express();
const PORT = 3000;
const ADMIN_PASSWORD = "admin"; // Пароль для входа в веб-админку

app.use(cors());
app.use(express.json());

// Настройка сессий для админки
app.use(
  session({
    secret: "medcalc-super-secret",
    resave: false,
    saveUninitialized: false,
    cookie: { maxAge: 24 * 60 * 60 * 1000 },
  })
);

const db = new sqlite3.Database("medcalc.db");

// --- ИНИЦИАЛИЗАЦИЯ ТАБЛИЦ ---
db.serialize(() => {
  db.run(
    `CREATE TABLE IF NOT EXISTS doctors (login TEXT PRIMARY KEY, password TEXT)`
  );
  db.run(`CREATE TABLE IF NOT EXISTS patients (policy TEXT PRIMARY KEY)`);
  db.run(`CREATE TABLE IF NOT EXISTS records (
    id TEXT PRIMARY KEY, calcId TEXT, timestamp TEXT, inputJson TEXT, 
    resultValue REAL, resultText TEXT, doctorLogin TEXT, patientPolicy TEXT
  )`);
});

// Проверка авторизации для веб-админки
const checkAuth = (req, res, next) => {
  if (req.session.isLoggedIn) next();
  else res.status(401).json({ error: "Unauthorized" });
};

// --- БЛОК 1: АВТОРИЗАЦИЯ (Для приложения) ---

// Вход врача
app.post("/api/auth/doctor", (req, res) => {
  const { login, password } = req.body;
  db.get(
    "SELECT * FROM doctors WHERE login = ? AND password = ?",
    [login, password],
    (err, row) => {
      if (row) res.json({ success: true, login: row.login });
      else
        res
          .status(401)
          .json({ success: false, message: "Неверный логин или пароль" });
    }
  );
});

// Проверка пациента
app.post("/api/auth/patient", (req, res) => {
  const { policy } = req.body;
  db.get("SELECT * FROM patients WHERE policy = ?", [policy], (err, row) => {
    if (row) res.json({ success: true });
    else res.status(401).json({ success: false, message: "Пациент не найден" });
  });
});

// --- БЛОК 2: РАБОТА С ДАННЫМИ (API) ---

app.get("/api/records", (req, res) => {
  db.all("SELECT * FROM records ORDER BY timestamp DESC", (err, rows) =>
    res.json(rows || [])
  );
});

app.post("/api/records", (req, res) => {
  const {
    id,
    calcId,
    timestamp,
    inputJson,
    resultValue,
    resultText,
    doctorLogin,
    patientPolicy,
  } = req.body;
  db.run(
    "INSERT INTO records (id, calcId, timestamp, inputJson, resultValue, resultText, doctorLogin, patientPolicy) VALUES (?,?,?,?,?,?,?,?)",
    [
      id,
      calcId,
      timestamp,
      inputJson,
      resultValue,
      resultText,
      doctorLogin,
      patientPolicy,
    ],
    (err) => (err ? res.status(500).json(err) : res.json({ id }))
  );
});

app.post("/api/records/bulk-delete", checkAuth, (req, res) => {
  const { ids } = req.body;
  const placeholders = ids.map(() => "?").join(",");
  db.run(`DELETE FROM records WHERE id IN (${placeholders})`, ids, () =>
    res.json({ success: true })
  );
});

// --- БЛОК 3: УПРАВЛЕНИЕ (Админка) ---

app.post("/api/login", (req, res) => {
  if (req.body.password === ADMIN_PASSWORD) {
    req.session.isLoggedIn = true;
    res.json({ success: true });
  } else res.status(401).json({ success: false });
});

app.get("/api/doctors", checkAuth, (req, res) => {
  db.all("SELECT login FROM doctors", (err, rows) => res.json(rows || []));
});

app.post("/api/doctors", checkAuth, (req, res) => {
  const { login, password } = req.body;
  db.run(
    "INSERT INTO doctors (login, password) VALUES (?, ?)",
    [login, password],
    (err) => {
      if (err) res.status(400).json({ error: "Логин занят" });
      else res.json({ success: true });
    }
  );
});

app.delete("/api/doctors/:login", checkAuth, (req, res) => {
  db.run("DELETE FROM doctors WHERE login = ?", [req.params.login], () =>
    res.json({ success: true })
  );
});

app.get("/api/patients", checkAuth, (req, res) => {
  db.all("SELECT * FROM patients", (err, rows) => res.json(rows || []));
});

app.post("/api/patients", checkAuth, (req, res) => {
  db.run(
    "INSERT INTO patients (policy) VALUES (?)",
    [req.body.policy],
    (err) => {
      if (err) res.status(400).json({ error: "Полис уже есть" });
      else res.json({ success: true });
    }
  );
});

app.post("/api/records/save-with-policy", (req, res) => {
  const {
    id,
    calcId,
    timestamp,
    inputJson,
    resultValue,
    resultText,
    doctorLogin,
    patientPolicy,
  } = req.body;

  // 1. Пытаемся добавить пациента. Если он есть — ничего не делаем (OR IGNORE)
  db.run(
    "INSERT OR IGNORE INTO patients (policy) VALUES (?)",
    [patientPolicy],
    (err) => {
      if (err)
        return res.status(500).json({ error: "Ошибка при работе с пациентом" });

      // 2. Сохраняем саму запись расчета
      db.run(
        "INSERT INTO records (id, calcId, timestamp, inputJson, resultValue, resultText, doctorLogin, patientPolicy) VALUES (?,?,?,?,?,?,?,?)",
        [
          id,
          calcId,
          timestamp,
          inputJson,
          resultValue,
          resultText,
          doctorLogin,
          patientPolicy,
        ],
        function (err) {
          if (err)
            return res
              .status(500)
              .json({ error: "Ошибка при сохранении расчета" });
          res.json({ success: true, recordId: id });
        }
      );
    }
  );
});

// --- БЛОК 4: ВНЕШНИЕ СЕРВИСЫ (PubMed прокси) ---

app.get("/api/pubmed", async (req, res) => {
  try {
    const { term } = req.query;
    const searchRes = await fetch(
      `https://eutils.ncbi.nlm.nih.gov/entrez/eutils/esearch.fcgi?db=pubmed&retmode=json&retmax=3&term=${encodeURIComponent(
        term
      )}`
    );
    const searchJson = await searchRes.json();
    const ids = searchJson.esearchresult.idlist;
    if (!ids || ids.length === 0) return res.json([]);

    const summaryRes = await fetch(
      `https://eutils.ncbi.nlm.nih.gov/entrez/eutils/esummary.fcgi?db=pubmed&retmode=json&id=${ids.join(
        ","
      )}`
    );
    const summaryJson = await summaryRes.json();

    const articles = ids.map((id) => ({
      id,
      title: summaryJson.result[id].title,
      url: `https://pubmed.ncbi.nlm.nih.gov/${id}`,
    }));
    res.json(articles);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Раздача фронтенда админки
app.get("/admin", (req, res) => {
  res.sendFile(path.join(__dirname, "admin.html"));
});

// ЗАПУСК (на 0.0.0.0 чтобы телефон видел сервер)
app.listen(PORT, "0.0.0.0", () => {
  console.log(`--- МЕД-СЕРВЕР ЗАПУЩЕН ---`);
  console.log(`Админка: http://localhost:3000/admin`);
  console.log(`Для приложения используйте порт 3000`);
});
