const fs = require("fs");
const path = require("path");
const { execFileSync } = require("child_process");

const PROJECT_ID = process.env.FIREBASE_PROJECT_ID || "importcalc";
const DATABASE_ID = "(default)";
const root = path.resolve(__dirname, "..");
const sourcePath = path.join(root, "shipping_companies.json");

function loadFirebaseAuth() {
  const npmRoot = process.platform === "win32"
    ? path.join(process.env.APPDATA, "npm", "node_modules")
    : execFileSync("npm", ["root", "-g"], { encoding: "utf8" }).trim();
  const firebaseRoot = path.join(npmRoot, "firebase-tools", "lib");
  return {
    auth: require(path.join(firebaseRoot, "auth")),
    requireAuth: require(path.join(firebaseRoot, "requireAuth")).requireAuth,
    Client: require(path.join(firebaseRoot, "apiv2")).Client,
  };
}

function slug(value) {
  return value
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

function firestoreValue(value) {
  if (value instanceof Date) return { timestampValue: value.toISOString() };
  if (value === null) return { nullValue: null };
  if (Array.isArray(value)) return { arrayValue: { values: value.map(firestoreValue) } };
  if (typeof value === "object") return { mapValue: { fields: firestoreFields(value) } };
  if (typeof value === "boolean") return { booleanValue: value };
  if (typeof value === "number") {
    return Number.isInteger(value)
      ? { integerValue: String(value) }
      : { doubleValue: value };
  }
  return { stringValue: String(value) };
}

function firestoreFields(object) {
  return Object.fromEntries(
    Object.entries(object)
      .filter(([, value]) => value !== undefined)
      .map(([key, value]) => [key, firestoreValue(value)])
  );
}

function documentWrite(collection, id, data) {
  const name = `projects/${PROJECT_ID}/databases/${DATABASE_ID}/documents/${collection}/${id}`;
  return { update: { name, fields: firestoreFields(data) } };
}

function documentDelete(name) {
  return { delete: name };
}

async function getFirestoreClient() {
  const { auth, requireAuth, Client } = loadFirebaseAuth();
  const account = auth.getGlobalDefaultAccount();
  if (!account) throw new Error("Firebase CLI login is required. Run: firebase login");
  const options = { project: PROJECT_ID, ...account };
  await requireAuth(options);
  return new Client({
    urlPrefix: "https://firestore.googleapis.com",
    apiVersion: "v1",
  });
}

async function batchWrite(client, writes) {
  const documentPath = `/projects/${PROJECT_ID}/databases/${DATABASE_ID}/documents:batchWrite`;
  const response = await client.post(documentPath, { writes });
  const body = response.body;
  const failures = (body.status || []).filter((status) => status.code && status.code !== 0);
  if (failures.length) throw new Error(`Firestore rejected ${failures.length} writes`);
}

async function countCollection(client, collection) {
  let pageToken = "";
  let count = 0;
  do {
    const queryParams = { pageSize: 300 };
    if (pageToken) queryParams.pageToken = pageToken;
    const documentPath = `/projects/${PROJECT_ID}/databases/${DATABASE_ID}/documents/${collection}`;
    const response = await client.get(documentPath, { queryParams });
    const body = response.body;
    count += (body.documents || []).length;
    pageToken = body.nextPageToken || "";
  } while (pageToken);
  return count;
}

async function listCollectionDocumentNames(client, collection) {
  let pageToken = "";
  const names = [];
  do {
    const queryParams = { pageSize: 300 };
    if (pageToken) queryParams.pageToken = pageToken;
    const documentPath = `/projects/${PROJECT_ID}/databases/${DATABASE_ID}/documents/${collection}`;
    const response = await client.get(documentPath, { queryParams });
    const body = response.body;
    names.push(...(body.documents || []).map((document) => document.name));
    pageToken = body.nextPageToken || "";
  } while (pageToken);
  return names;
}

async function main() {
  const source = JSON.parse(fs.readFileSync(sourcePath, "utf8"));
  const capturedAt = new Date(`${source.updatedAt}T00:00:00+04:00`);
  const writes = [];
  const currentCompanyNames = new Set();
  const currentRouteNames = new Set();
  let routeCount = 0;

  for (const company of source.companies) {
    const companyId = slug(company.name);
    currentCompanyNames.add(`projects/${PROJECT_ID}/databases/${DATABASE_ID}/documents/shipping_companies/${companyId}`);
    const { routes, ...companyProfile } = company;
    const currentCompany = {
      companyId,
      ...companyProfile,
      routeCount: routes.length,
      dataVersion: source.dataVersion,
      updatedAt: capturedAt,
    };
    writes.push(documentWrite("shipping_companies", companyId, currentCompany));
    writes.push(
      documentWrite("shipping_company_history", `${companyId}_v${source.dataVersion}`, {
        ...currentCompany,
        capturedAt,
      })
    );

    for (const route of routes) {
      const routeId = slug(`${company.name}-${route.fromCountryCode}-${route.toCountryCode}-${route.type}`);
      currentRouteNames.add(`projects/${PROJECT_ID}/databases/${DATABASE_ID}/documents/shipping_routes/${routeId}`);
      const currentRoute = {
        routeId,
        companyId,
        companyName: company.name,
        ...route,
        dataVersion: source.dataVersion,
        updatedAt: capturedAt,
      };
      writes.push(documentWrite("shipping_routes", routeId, currentRoute));
      writes.push(
        documentWrite("shipping_rate_history", `${routeId}_v${source.dataVersion}`, {
          ...currentRoute,
          capturedAt,
        })
      );
      routeCount += 1;
    }
  }

  for (const change of source.changeEvents || []) {
    writes.push(
      documentWrite("shipping_changes", change.id, {
        ...change,
        changedAt: new Date(change.changedAt),
        dataVersion: source.dataVersion,
      })
    );
  }

  writes.push(
    documentWrite("shipping_metadata", "current", {
      dataVersion: source.dataVersion,
      changeVersion: source.changeVersion || 0,
      companyCount: source.companies.length,
      routeCount,
      sourceUpdatedAt: capturedAt,
      migratedAt: new Date(),
    })
  );

  if (writes.length > 500) throw new Error(`Migration has ${writes.length} writes; split the batch first.`);
  const client = await getFirestoreClient();
  await batchWrite(client, writes);

  const staleWrites = [];
  for (const name of await listCollectionDocumentNames(client, "shipping_companies")) {
    if (!currentCompanyNames.has(name)) staleWrites.push(documentDelete(name));
  }
  for (const name of await listCollectionDocumentNames(client, "shipping_routes")) {
    if (!currentRouteNames.has(name)) staleWrites.push(documentDelete(name));
  }
  if (staleWrites.length) await batchWrite(client, staleWrites);

  const collections = [
    "shipping_companies",
    "shipping_routes",
    "shipping_rate_history",
    "shipping_company_history",
    "shipping_changes",
    "shipping_metadata",
  ];
  const counts = {};
  for (const collection of collections) counts[collection] = await countCollection(client, collection);

  console.log(JSON.stringify({ project: PROJECT_ID, dataVersion: source.dataVersion, writes: writes.length, staleDocumentsDeleted: staleWrites.length, counts }, null, 2));
}

main().catch((error) => {
  console.error(error.message);
  process.exit(1);
});
