// Boundary parsing tests for the shared query helpers (routes PRD §3):
// pagination defaults + clamps, filter mapping onto the repository *Filter
// types, and strict rejection of unknown or out-of-enum parameters.
import { assert, assertEquals } from "@std/assert";
import {
  parseDeviceListQuery,
  parseSoftwareListQuery,
  queryString,
} from "@/routes/(_shared)/query.ts";

function params(qs: string): URLSearchParams {
  return new URL(`http://localhost/x?${qs}`).searchParams;
}

Deno.test("pagination defaults to limit=50 offset=0", () => {
  const result = parseDeviceListQuery(params(""));
  assert(result.ok);
  assertEquals(result.value.page, { limit: 50, offset: 0 });
  assertEquals(result.value.filter, {});
});

Deno.test("pagination clamps limit to 1..200 and floors offset at 0", () => {
  const big = parseDeviceListQuery(params("limit=9999&offset=10"));
  assert(big.ok);
  assertEquals(big.value.page.limit, 200);
  assertEquals(big.value.page.offset, 10);

  const small = parseDeviceListQuery(params("limit=0"));
  assert(small.ok);
  assertEquals(small.value.page.limit, 1);

  const negative = parseDeviceListQuery(params("offset=-5"));
  assert(negative.ok);
  assertEquals(negative.value.page.offset, 0);
});

Deno.test("non-numeric pagination is a validation error", () => {
  const result = parseDeviceListQuery(params("limit=abc"));
  assertEquals(result.ok, false);
});

Deno.test("device filters map onto DeviceFilter", () => {
  const result = parseDeviceListQuery(params(
    "status=quarantined&deviceClass=enterprise_asset&enterpriseAssetType=server" +
      "&environment=cloud&criticality=high&department=Finance&hostname=web",
  ));
  assert(result.ok);
  assertEquals(result.value.filter, {
    status: "quarantined",
    deviceClass: "enterprise_asset",
    enterpriseAssetType: "server",
    environment: "cloud",
    criticality: "high",
    department: "Finance",
    hostnameContains: "web",
  });
});

Deno.test("out-of-enum device filter value is rejected, not an empty result", () => {
  const result = parseDeviceListQuery(params("status=bogus"));
  assertEquals(result.ok, false);
  if (!result.ok) {
    // Issues carry field/code only — the untrusted value is never echoed
    // back, not even inside the message text (AGENTS.md §2.7).
    assert(result.issues.every((i) => !("value" in i)));
    assertEquals(result.issues[0].field, "status");
    assert(!JSON.stringify(result.issues).includes("bogus"));
  }
});

Deno.test("unknown query parameters are rejected without echoing the key", () => {
  const result = parseDeviceListQuery(params("nope=1"));
  assertEquals(result.ok, false);
  if (!result.ok) {
    assert(
      !JSON.stringify(result.issues.map((i) => i.message)).includes("nope"),
    );
  }
});

Deno.test("empty-string params mean 'no filter' (GET form submissions)", () => {
  const result = parseDeviceListQuery(
    params("status=&department=&hostname=&limit="),
  );
  assert(result.ok);
  assertEquals(result.value.filter, {});
  assertEquals(result.value.page.limit, 50);
});

Deno.test("software filters map onto SoftwareFilter", () => {
  const result = parseSoftwareListQuery(params(
    "softwareType=application&authorizationStatus=unauthorized" +
      "&supportStatus=eol_flagged&criticality=medium&eolBefore=2027-01-01&title=chrome",
  ));
  assert(result.ok);
  assertEquals(result.value.filter, {
    softwareType: "application",
    authorizationStatus: "unauthorized",
    supportStatus: "eol_flagged",
    criticality: "medium",
    eolBefore: "2027-01-01",
    titleContains: "chrome",
  });
});

Deno.test("software eolBefore must be an ISO date", () => {
  const result = parseSoftwareListQuery(params("eolBefore=notadate"));
  assertEquals(result.ok, false);
});

Deno.test("queryString round-trips filters and applies overrides", () => {
  const qs = queryString(
    params("status=authorized&offset=50&limit=25"),
    { offset: "75" },
  );
  const back = new URLSearchParams(qs);
  assertEquals(back.get("status"), "authorized");
  assertEquals(back.get("offset"), "75");
  assertEquals(back.get("limit"), "25");
});
