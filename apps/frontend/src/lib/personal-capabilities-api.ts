import { PersonalCapabilitiesSchema, type PersonalCapabilitiesUpdate } from "@cogniplane/shared-types";
import { requestJson } from "./api-client";

export async function getPersonalCapabilities() {
  return await requestJson("/me/capabilities", PersonalCapabilitiesSchema);
}

export async function updatePersonalCapabilities(input: PersonalCapabilitiesUpdate) {
  return await requestJson("/me/capabilities", PersonalCapabilitiesSchema, { method: "PUT", body: JSON.stringify(input) });
}
