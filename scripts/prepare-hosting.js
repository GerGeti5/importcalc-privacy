const fs = require("fs");
const path = require("path");

const repositoryRoot = path.resolve(__dirname, "..");
const hostingPublic = path.join(repositoryRoot, "deploy", "public");

for (const fileName of ["shipping_companies.json", "update.json"]) {
  const source = path.join(repositoryRoot, fileName);
  const destination = path.join(hostingPublic, fileName);

  if (!fs.existsSync(source)) {
    throw new Error(`Missing canonical hosting file: ${source}`);
  }

  fs.mkdirSync(hostingPublic, { recursive: true });
  fs.copyFileSync(source, destination);
}

const shippingData = JSON.parse(
  fs.readFileSync(path.join(hostingPublic, "shipping_companies.json"), "utf8"),
);
const updateData = JSON.parse(
  fs.readFileSync(path.join(hostingPublic, "update.json"), "utf8"),
);

if (shippingData.dataVersion !== updateData.shippingDataVersion) {
  throw new Error(
    `Shipping version mismatch: data=${shippingData.dataVersion}, update=${updateData.shippingDataVersion}`,
  );
}

if (!fs.existsSync(path.join(hostingPublic, "index.html"))) {
  throw new Error("Hosting deploy blocked: deploy/public/index.html is missing");
}

console.log(
  `Hosting files prepared: dataVersion ${shippingData.dataVersion}, ` +
    `${shippingData.companies.length} companies`,
);
