<?php
require_once __DIR__ . '/common.php';
send_common_headers();

if ($_SERVER['REQUEST_METHOD'] !== 'POST') {
    json_error(405, 'Use POST');
}

$body = read_json_body();
$email = trim((string) ($body['email'] ?? ''));

// This response is deliberately identical whether or not the email belongs to
// an account — an attacker (or just a curious person) shouldn't be able to
// use "did I get an error or not" to find out which emails have accounts.
$generic = ['ok' => true, 'message' => 'If an account exists for that email, a reset link has been sent.'];

if (!is_valid_email($email)) {
    json_response(200, $generic);
}

$db = get_db();
$stmt = $db->prepare('SELECT id, name FROM users WHERE email = ?');
$stmt->execute([$email]);
$user = $stmt->fetch();

if ($user) {
    // Opportunistically clear out this user's old/expired reset requests so
    // the table doesn't accumulate dead rows every time someone clicks
    // "forgot password" more than once.
    $db->prepare('DELETE FROM password_resets WHERE user_id = ? AND expires_at < NOW()')->execute([$user['id']]);

    $token = generate_token();
    $expiresAt = date('Y-m-d H:i:s', time() + 3600); // 1 hour — shorter-lived than a login session on purpose
    $db->prepare('INSERT INTO password_resets (token, user_id, expires_at) VALUES (?, ?, ?)')
       ->execute([$token, $user['id'], $expiresAt]);

    // ALLOWED_ORIGIN is the app's own URL (e.g. https://linksman-six.vercel.app),
    // already configured for CORS — reused here so there's no second URL to
    // keep in sync in config.php. The app reads ?reset_token=... on load (see
    // ResetPasswordScreen in App.jsx) and shows the "choose a new password"
    // screen instead of the normal login/app.
    $resetUrl = ALLOWED_ORIGIN . '/?reset_token=' . urlencode($token);
    $name = $user['name'] !== '' ? $user['name'] : 'there';
    $subject = 'Reset your Linksman password';
    $textBody = "Hi {$name},\n\n"
        . "Someone (hopefully you) asked to reset the password for your Linksman account.\n\n"
        . "Click this link to choose a new password — it's valid for 1 hour:\n{$resetUrl}\n\n"
        . "If you didn't ask for this, you can ignore this email and your password will stay the same.\n";
    $headers = "From: Linksman <noreply@tarakona.co.za>\r\n"
        . "Content-Type: text/plain; charset=UTF-8\r\n";

    // @ suppresses a warning if the server's mail setup is misconfigured —
    // the response to the browser stays the same generic message either way,
    // so a broken mail server doesn't leak account existence either.
    @mail($email, $subject, $textBody, $headers);
}

json_response(200, $generic);
