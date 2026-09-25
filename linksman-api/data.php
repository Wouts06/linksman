<?php
require_once __DIR__ . '/common.php';
send_common_headers();

// The only data_key values the app is allowed to read/write — matches the
// golf:* keys the frontend already uses in localStorage (see loadKey/saveKey
// in App.jsx), just without the "golf:" prefix.
$ALLOWED_KEYS = ['courses', 'players', 'rounds', 'settings', 'mePlayerId', 'rangefinderDefault'];

$userId = require_auth();
$db = get_db();

if ($_SERVER['REQUEST_METHOD'] === 'GET') {
    $stmt = $db->prepare('SELECT data_key, data_json FROM user_data WHERE user_id = ?');
    $stmt->execute([$userId]);
    $out = [];
    foreach ($stmt->fetchAll() as $row) {
        $out[$row['data_key']] = json_decode($row['data_json'], true);
    }
    // A PHP associative array with nothing in it is indistinguishable from a
    // list, so json_encode would render it as "[]" instead of "{}" — force
    // the empty case to an object so the frontend can always treat the
    // response as {courses?, players?, ...} rather than special-casing an array.
    json_response(200, empty($out) ? new stdClass() : $out);
}

if ($_SERVER['REQUEST_METHOD'] === 'POST') {
    $body = read_json_body();

    // Accept either one {key, value} pair, or a bulk {items: [{key, value}, ...]}
    // (used right after login/signup to push everything currently in
    // localStorage up to the server in one request instead of one per key).
    $items = [];
    if (isset($body['items']) && is_array($body['items'])) {
        $items = $body['items'];
    } elseif (isset($body['key'])) {
        $items = [$body];
    } else {
        json_error(400, 'Expected {key, value} or {items: [...]}');
    }

    if (count($items) > 20) {
        json_error(400, 'Too many items in one request');
    }

    $upsert = $db->prepare(
        'INSERT INTO user_data (user_id, data_key, data_json) VALUES (?, ?, ?)
         ON DUPLICATE KEY UPDATE data_json = VALUES(data_json)'
    );

    $db->beginTransaction();
    try {
        foreach ($items as $item) {
            $key = $item['key'] ?? null;
            if (!in_array($key, $ALLOWED_KEYS, true)) {
                throw new InvalidArgumentException("Unknown data key: " . var_export($key, true));
            }
            // value is allowed to be any JSON-serializable value, including null
            // (e.g. mePlayerId when nothing is selected yet).
            $json = json_encode(array_key_exists('value', $item) ? $item['value'] : null);
            if ($json === false) {
                throw new InvalidArgumentException("Value for '$key' could not be encoded as JSON");
            }
            $upsert->execute([$userId, $key, $json]);
        }
        $db->commit();
    } catch (InvalidArgumentException $e) {
        $db->rollBack();
        json_error(400, $e->getMessage());
    }

    json_response(200, ['ok' => true]);
}

json_error(405, 'Use GET or POST');
