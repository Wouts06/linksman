<?php
require_once __DIR__ . '/common.php';
send_common_headers();

if ($_SERVER['REQUEST_METHOD'] !== 'POST') {
    json_error(405, 'Use POST');
}

$body = read_json_body();
$email = trim((string) ($body['email'] ?? ''));
$password = (string) ($body['password'] ?? '');

if ($email === '' || $password === '') {
    json_error(400, 'Email and password are required');
}

$db = get_db();
$stmt = $db->prepare('SELECT id, email, name, password_hash FROM users WHERE email = ?');
$stmt->execute([$email]);
$user = $stmt->fetch();

// Same error for "no such user" and "wrong password" — don't reveal which
// one it was, so an attacker can't use this endpoint to enumerate accounts.
if (!$user || !password_verify($password, $user['password_hash'])) {
    json_error(401, 'Incorrect email or password');
}

$token = generate_token();
$expiresAt = date('Y-m-d H:i:s', time() + SESSION_DAYS * 86400);
$db->prepare('INSERT INTO sessions (token, user_id, expires_at) VALUES (?, ?, ?)')
   ->execute([$token, $user['id'], $expiresAt]);

json_response(200, [
    'token' => $token,
    'user' => ['id' => (int) $user['id'], 'email' => $user['email'], 'name' => $user['name']],
]);
