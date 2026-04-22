const { Pool } = require("pg");

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
});

pool.on("error", (err) => {
  console.error("[PostgreSQL] Error en el pool:", err.message);
});

module.exports = pool;
