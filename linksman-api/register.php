<?php
require_once __DIR__ . '/common.php';
send_common_headers();

if ($_SERVER['REQUEST_METHOD'] !== 'POST') {
    json_error(405, 'Use POST');
}

$body = read_json_body();
$email = trim((string) ($body['email'] ?? ''));
$password = (string) ($body['password'] ?? '');
$name = trim((string) ($body['name'] ?? ''));

if (!is_valid_email($email)) {
    json_error(400, 'Please enter a valid email address');
}
if (strlen($password) < 8) {
    json_error(400, 'Password must be at least 8 characters');
}
if ($name === '') {
    json_error(400, 'Please enter your name');
}
if (strlen($name) > 255) {
    json_error(400, 'Name is too long');
}

$db = get_db();

$stmt = $db->prepare('SELECT id FROM users WHERE email = ?');
$stmt->execute([$email]);
if ($stmt->fetch()) {
    json_error(409, 'An account with that email already exists');
}

$hash = password_hash($password, PASSWORD_DEFAULT);

$db->prepare('INSERT INTO users (email, password_hash, name) VALUES (?, ?, ?)')
   ->execute([$email, $hash, $name]);
$userId = (int) $db->lastInsertId();

$token = generate_token();
$expiresAt = date('Y-m-d H:i:s', time() + SESSION_DAYS * 86400);
$db->prepare('INSERT INTO sessions (token, user_id, expires_at) VALUES (?, ?, ?)')
   ->execute([$token, $userId, $expiresAt]);

json_response(201, [
    'token' => $token,
    'user' => ['id' => $userId, 'email' => $email, 'name' => $name],
]);
