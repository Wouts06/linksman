<?php
require_once __DIR__ . '/common.php';
send_common_headers();

if ($_SERVER['REQUEST_METHOD'] !== 'POST') {
    json_error(405, 'Use POST');
}

$body = read_json_body();
$token = (string) ($body['token'] ?? '');
$password = (string) ($body['password'] ?? '');

if (!preg_match('/^[a-f0-9]{64}$/i', $token)) {
    json_error(400, 'This reset link is invalid or has expired. Please request a new one.');
}
if (strlen($password) < 8) {
    json_error(400, 'Password must be at least 8 characters');
}

$db = get_db();
$stmt = $db->prepare('SELECT user_id, expires_at FROM password_resets WHERE token = ?');
$stmt->execute([$token]);
$row = $stmt->fetch();

if (!$row) {
    json_error(400, 'This reset link is invalid or has expired. Please request a new one.');
}
if (strtotime($row['expires_at']) < time()) {
    $db->prepare('DELETE FROM password_resets WHERE token = ?')->execute([$token]);
    json_error(400, 'This reset link is invalid or has expired. Please request a new one.');
}

$userId = (int) $row['user_id'];
$hash = password_hash($password, PASSWORD_DEFAULT);

$db->beginTransaction();
try {
    $db->prepare('UPDATE users SET password_hash = ? WHERE id = ?')->execute([$hash, $userId]);
    // single-use — this link (and any other pending reset request for this
    // account) is now spent
    $db->prepare('DELETE FROM password_resets WHERE user_id = ?')->execute([$userId]);
    // invalidate every device that was already logged in — if the password
    // was reset because the account was compromised, an old session
    // shouldn't silently keep working after this
    $db->prepare('DELETE FROM sessions WHERE user_id = ?')->execute([$userId]);
    $db->commit();
} catch (Exception $e) {
    $db->rollBack();
    json_error(500, 'Something went wrong — please try again.');
}

// log the user straight in with their new password, same response shape login.php uses
$stmt = $db->prepare('SELECT id, email, name FROM users WHERE id = ?');
$stmt->execute([$userId]);
$user = $stmt->fetch();

$newToken = generate_token();
$expiresAt = date('Y-m-d H:i:s', time() + SESSION_DAYS * 86400);
$db->prepare('INSERT INTO sessions (token, user_id, expires_at) VALUES (?, ?, ?)')
   ->execute([$newToken, $userId, $expiresAt]);

json_response(200, [
    'token' => $newToken,
    'user' => ['id' => $userId, 'email' => $user['email'], 'name' => $user['name']],
]);
