<?php
/**
 * Copy this file to config.php (same folder) and fill in your real values.
 * config.php is never committed to the app's git repo — it stays only on the
 * server, since it holds your database password.
 *
 * Where these values come from in InterWorx:
 *   - DB_HOST is almost always "localhost" for a database on the same account.
 *   - DB_NAME / DB_USER are whatever you named them when you created the
 *     database and its MySQL user in InterWorx (SiteWorx panel -> MySQL).
 *   - DB_PASS is the password you set for that MySQL user.
 *
 * ALLOWED_ORIGIN must be the exact origin (scheme + host, no trailing slash)
 * that the app is served from, so the browser's CORS check allows the
 * request through. Using your Vercel deployment as an example:
 */

define('DB_HOST', 'localhost');
define('DB_NAME', 'your_db_name');
define('DB_USER', 'your_db_user');
define('DB_PASS', 'your_db_password');

define('ALLOWED_ORIGIN', 'https://linksman-six.vercel.app');

// Session tokens are valid for this many days before a user has to log in again.
define('SESSION_DAYS', 30);
