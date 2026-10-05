export const TICKET_OWNER_MODEL = 'gpt-6-sol';
export const LEGACY_UNVERSIONED_MODEL = 'gpt-5.5';

export function isLegacyTicketOwnerModel(model) {
  return model === LEGACY_UNVERSIONED_MODEL
    || (typeof model === 'string' && /^gpt-5\.6-[a-z][a-z0-9-]*$/.test(model));
}
