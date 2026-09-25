-- Linksman database schema
-- Run this once in phpMyAdmin, against the database you created for this app
-- (e.g. via InterWorx: create a MySQL database + a MySQL user with full privileges
-- on it, then open that database in phpMyAdmin and use the "Import" or "SQL" tab
-- to run this whole file).

-- Registered users. One row per person who creates an account in the app.
CREATE TABLE IF NOT EXISTS users (
  id INT UNSIGNED NOT NULL AUTO_INCREMENT,
  email VARCHAR(255) NOT NULL,
  password_hash VARCHAR(255) NOT NULL,
  name VARCHAR(255) NOT NULL,
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  UNIQUE KEY uniq_email (email)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- Login sessions. A row = one "logged in" bearer token, checked on every API
-- request and deleted on logout or once it expires.
CREATE TABLE IF NOT EXISTS sessions (
  token CHAR(64) NOT NULL,
  user_id INT UNSIGNED NOT NULL,
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  expires_at DATETIME NOT NULL,
  PRIMARY KEY (token),
  KEY idx_user_id (user_id),
  CONSTRAINT fk_sessions_user FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- Password reset requests. A row = one emailed reset link, valid for 1 hour
-- and single-use (deleted the moment it's used, or once it's expired).
CREATE TABLE IF NOT EXISTS password_resets (
  token CHAR(64) NOT NULL,
  user_id INT UNSIGNED NOT NULL,
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  expires_at DATETIME NOT NULL,
  PRIMARY KEY (token),
  KEY idx_user_id (user_id),
  CONSTRAINT fk_password_resets_user FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- The app's actual data, stored the same shape it already uses in the browser's
-- localStorage (one JSON blob per key: courses / players / rounds / settings /
-- mePlayerId / rangefinderDefault). Keeping the same shape server-side means the
-- rest of the app's logic doesn't have to change — this table is just a durable,
-- per-account copy of what used to live only in localStorage.
CREATE TABLE IF NOT EXISTS user_data (
  user_id INT UNSIGNED NOT NULL,
  data_key VARCHAR(64) NOT NULL,
  data_json LONGTEXT NOT NULL,
  updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (user_id, data_key),
  CONSTRAINT fk_user_data_user FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
