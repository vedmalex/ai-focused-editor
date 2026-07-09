export const ModelProviderRegistry = Symbol('ModelProviderRegistry');

export interface ModelProviderAlias {
  id: string;
  label: string;
  provider: string;
  model: string;
  enabled: boolean;
}

export interface ModelProviderRegistry {
  getActiveAlias(): Promise<ModelProviderAlias | undefined>;
  listAliases(): Promise<ModelProviderAlias[]>;
}

