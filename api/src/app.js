require("dotenv").config();
const express = require("express");
const importacionesRouter = require("./routes/importaciones");
const dashboardRouter    = require("./routes/dashboard");
const alertasRouter      = require("./routes/alertas");
const authRouter         = require("./routes/auth");
const usuariosRouter     = require("./routes/usuarios");
const reportesRouter     = require("./routes/reportes");

const app = express();
const PORT = process.env.PORT || 3000;

app.use(express.json());
app.use("/api/v1", importacionesRouter);
app.use("/api/v1", dashboardRouter);
app.use("/api/v1", alertasRouter);
app.use("/api/v1", authRouter);
app.use("/api/v1", usuariosRouter);
app.use("/api/v1", reportesRouter);

// 404
app.use((_req, res) => {
  res.status(404).json({ error: "Ruta no encontrada" });
});

// Error handler global
// eslint-disable-next-line no-unused-vars
app.use((err, _req, res, _next) => {
  console.error("[ERROR GLOBAL]", err);
  res.status(500).json({ error: "Error interno del servidor" });
});

app.listen(PORT, () => {
  console.log(`NovaRetail API escuchando en http://localhost:${PORT}`);
});

module.exports = app;
