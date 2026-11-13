# SPX seller portal — protocol notes

Notes for maintainers, read from the live portal and its JS bundles (2026-11-10). Update this file when you discover
something new.

## Login

- `spx.vn/spx-admin` without a session redirects to
  `account.spx.vn/authenticate/login?next=…/shipment/account/api/login…`. The form takes a phone number, username or
  email + password (another tab offers SMS login).
- The page calls `POST account.spx.vn/api/v4/account/business/check_account_exist_by_password`, then
  `…/authenticate_toc_by_password` with `{phone, password, security_device_fingerprint}`. The fingerprint comes from the
  page's anti-bot JS, so the page itself must run — do not call the API bare and do not fake the fingerprint.
- Errors come back as `{error: N}` with HTTP 200. Known: `48401004` = account does not exist or wrong password.
- On success `next` sets the `spx_token` cookie (httpOnly, `spx.vn`) and returns to `/spx-admin`.

## Seller APIs

Every API lives under `https://spx.vn/shipment/*`, authenticated by the session cookie, and returns
`{retcode, message, data}` — `retcode` 0 = success.

| Endpoint | Notes |
|---|---|
| `GET /shipment/account/api/base_info/detail` | Account info; `account_id` is the wallet's `biz_account_id` |
| `GET /shipment/forward/account/api/spx_seller/seller_balance/detail` | `business_entity=4&product_line=7&biz_account_id=` |
| `POST …/seller_balance/transaction_list` | `biz_account_id` MUST be a string (a number → `-1000012 ReadString`) |
| `POST /shipment/order/logistic/order/list_all_order` | `{page_size, offset, language}` |
| `GET /shipment/order/logistic/label/batch_get_shipping_label?order_sn_list=` | PDF, keyed by `order_sn` |

Seen in the bundle but not used yet (`pages-ordercreation`): `order/logistic/order/batch_check_order` (check + fees),
`order/logistic/order/v2/batch_create_order`, `v2/excel_upload`, `v2/excel_check`, `v2/create_order_draft`,
`common/get_nonce_token`. Their payloads are assembled by the portal from its draft — capture them with a real session
before relying on them. This is why `createMassOrders` drives the page instead.

## Bulk creation page

`spx.vn/spx-admin/mass-order/create` (Vietnamese UI):

- The file input only exists after clicking **Nhập từ Excel**; attach the file with `DataTransfer` and fire
  `input` + `change`.
- Leftover drafts stack with a new import — clear them with **Nhập lại** + its confirmation first.
- Importing resets the collection method to pickup; select **Gửi tại điểm** (drop-off) again afterwards and wait for
  the fees to be recomputed.
- Counts: **Sẵn sàng tạo đơn N** (ready) / **Đơn chưa hợp lệ M** (invalid). Wait until they are stable before acting.

## Public tracking

`GET https://spx.vn/shipment/order/open/order/get_order_info?spx_tn=<tracking number>` — no cookie.

- `data.order_info.tracking_code_group_name`: status group in English.
- `data.sls_tracking_info.records[]`, newest first: `tracking_code`, `tracking_name`, `description`,
  `buyer_description`, `actual_time` (unix seconds), `display_flag` (1 = shown on the public page),
  `current_location.location_name`.
- Codes: `F000` Manifested · `F100` Pickup From Seller · `F440`/`F450` Enter/Left First Mile Hub · `F510`/`F540`
  Enter/Left Sorting Center · `F599` Enter Last Mile Hub · `F600` Out For Delivery · `F980` Delivered.
- A full desktop Chrome user agent gets **HTTP 403**; `Mozilla/5.0` or no user agent is served (2026-11-13).
