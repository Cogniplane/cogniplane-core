import { PersonalCapabilitiesSchema, type PersonalCapabilitiesUpdate } from "@cogniplane/shared-types";
import { request } from "./api-client";
import { parseResponse } from "./validate-response";

export async function getPersonalCapabilities() {
  return parseResponse(PersonalCapabilitiesSchema,
    await request<unknown>("/me/capabilities"), "GET /me/capabilities");
}

export async function updatePersonalCapabilities(input: PersonalCapabilitiesUpdate) {
  return parseResponse(PersonalCapabilitiesSchema,
    await request<unknown>("/me/capabilities", { method: "PUT", body: JSON.stringify(input) }),
    "PUT /me/capabilities");
}
