<?php
/**
 * Shared helpers included by every endpoint in this folder. Keeps the actual
 * endpoint files (register.php, login.php, logout.php, data.php) short and
 * focused on their one job.
 */

require_once __DIR__ . '/config.php';

/**
 * CORS + JSON headers, and short-circuits the browser's CORS preflight
 * (OPTIONS) request. Call this first thing in every endpoint.
 */
function send_common_headers() {
    header('Access-Control-Allow-Origin: ' . ALLOWED_ORIGIN);
    header('Access-Control-Allow-Methods: GET, POST, OPTIONS');
    header('Access-Control-Allow-Headers: Content-Type, Authorization');
    header('Access-Control-Max-Age: 86400');
    header('Content-Type: application/json; charset=utf-8');

    if ($_SERVER['REQUEST_METHOD'] === 'OPTIONS') {
        http_response_code(204);
        exit;
    }
}

/** Sends a JSON response with the given HTTP status and stops execution. */
function json_response($status, $data) {
    http_response_code($status);
    echo json_encode($data);
    exit;
}

/** Sends a JSON error response ({"error": "..."}) and stops execution. */
function json_error($status, $message) {
    json_response($status, ['error' => $message]);
}

/** Reads and JSON-decodes the request body; errors out on invalid JSON. */
function read_json_body() {
    $raw = file_get_contents('php://input');
    if ($raw === '' || $raw === false) return [];
    $data = json_decode($raw, true);
    if (json_last_error() !== JSON_ERROR_NONE) {
        json_error(400, 'Invalid JSON body');
    }
    return $data ?? [];
}

/** One shared PDO connection, created on first use. */
function get_db() {
    static $pdo = null;
    if ($pdo === null) {
        $dsn = 'mysql:host=' . DB_HOST . ';dbname=' . DB_NAME . ';charset=utf8mb4';
        try {
            $pdo = new PDO($dsn, DB_USER, DB_PASS, [
                PDO::ATTR_ERRMODE => PDO::ERRMODE_EXCEPTION,
                PDO::ATTR_DEFAULT_FETCH_MODE => PDO::FETCH_ASSOC,
            ]);
        } catch (PDOException $e) {
            // Never leak DB credentials/host details to the client.
            json_error(500, 'Database connection failed');
        }
    }
    return $pdo;
}

/** Generates a random, URL-safe session token. */
function generate_token() {
    return bin2hex(random_bytes(32)); // 64 hex chars, matches sessions.token CHAR(64)
}

/**
 * Reads the "Authorization: Bearer <token>" header, looks it up in the
 * sessions table, and returns the associated user_id — or sends a 401 and
 * stops execution if the token is missing, unknown, or expired.
 */
function require_auth() {
    $header = $_SERVER['HTTP_AUTHORIZATION'] ?? '';
    if ($header === '' && function_exists('apache_request_headers')) {
        // Some PHP/Apache setups don't populate HTTP_AUTHORIZATION directly.
        $headers = apache_request_headers();
        $header = $headers['Authorization'] ?? $headers['authorization'] ?? '';
    }
    if (!preg_match('/^Bearer\s+([a-f0-9]{64})$/i', trim($header), $m)) {
        json_error(401, 'Missing or malformed Authorization header');
    }
    $token = $m[1];

    $db = get_db();
    $stmt = $db->prepare('SELECT user_id, expires_at FROM sessions WHERE token = ?');
    $stmt->execute([$token]);
    $row = $stmt->fetch();
    if (!$row) {
        json_error(401, 'Invalid session');
    }
    if (strtotime($row['expires_at']) < time()) {
        // Clean up the expired row while we're here.
        $db->prepare('DELETE FROM sessions WHERE token = ?')->execute([$token]);
        json_error(401, 'Session expired, please log in again');
    }
    return (int) $row['user_id'];
}

/** Basic shape check for an email address, without being overly strict. */
function is_valid_email($email) {
    return is_string($email) && strlen($email) <= 255 && filter_var($email, FILTER_VALIDATE_EMAIL) !== false;
}
