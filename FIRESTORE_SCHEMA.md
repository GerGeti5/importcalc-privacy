# ImportCalc shipping data schema

The existing JSON feed remains the compatibility fallback for released app versions.
Firestore becomes the source for structured current data, change history, and Premium reports.

## Collections

- `shipping_companies/{companyId}`: name, website, logo, verification status, contacts, warehouses, and branch/address data.
- `shipping_routes/{routeId}`: company, origin, destination, type, price, currency, delivery time, and source metadata.
- `shipping_rate_history/{historyId}`: immutable route snapshots used for price charts and Premium history.
- `shipping_changes/{changeId}`: user-facing additions, removals, price changes, route changes, address changes, and branch changes.
- `shipping_metadata/current`: public data and change versions plus the last successful refresh time.
- `shipping_update_runs/{runId}`: private collector status and errors.
- `users/{uid}/shipping_state/current`: optional cross-device last-seen change version for authenticated users.

## Compatibility sequence

1. Keep publishing `shipping_companies.json` and `update.json` for existing app versions.
2. Write every verified update to Firestore and append changed route snapshots to history.
3. Generate the JSON feed from the same verified dataset.
4. A new app version reads Firestore first and falls back to the cached/hosted JSON on any error.
5. Enable authenticated Premium history only after billing and entitlement checks are ready.

Firestore database creation is intentionally not included here because its region is permanent and must be confirmed first.
