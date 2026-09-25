<?php
require_once __DIR__ . '/common.php';
send_common_headers();

if ($_SERVER['REQUEST_METHOD'] !== 'POST') {
    json_error(405, 'Use POST');
}

// Deliberately not using require_auth() here — an already-invalid/expired
// token should still "succeed" at logging out (there's nothing left to do),
// rather than erroring on the way out.
$header = $_SERVER['HTTP_AUTHORIZATION'] ?? '';
if (preg_match('/^Bearer\s+([a-f0-9]{64})$/i', trim($header), $m)) {
    get_db()->prepare('DELETE FROM sessions WHERE token = ?')->execute([$m[1]]);
}

json_response(200, ['ok' => true]);
