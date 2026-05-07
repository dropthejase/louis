import type { PreTokenGenerationV2TriggerEvent } from 'aws-lambda';

export const handler = async (
  event: PreTokenGenerationV2TriggerEvent,
): Promise<PreTokenGenerationV2TriggerEvent> => {
  event.response = {
    claimsAndScopeOverrideDetails: {
      idTokenGeneration: {
        claimsToAddOrOverride: {
          role: 'authenticated',
        },
      },
    },
  };
  return event;
};
