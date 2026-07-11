import type { AuditContext, Page, PageRequest } from "./common.ts";

// NIST ID.AM-04; groundwork for Control 15 (service provider management).
export interface ServiceProvider {
  id: string;
  name: string;
  servicesProvided: string;
  dataClassificationHandled: string;
  contractReference: string | null; // contract/SLA reference
  createdAt: string;
  updatedAt: string;
}

export interface CreateServiceProvider {
  name: string;
  servicesProvided: string;
  dataClassificationHandled: string;
  contractReference?: string | null;
}

export type UpdateServiceProvider = Partial<CreateServiceProvider>;

export interface IServiceProviderRepository {
  create(
    input: CreateServiceProvider,
    ctx: AuditContext,
  ): Promise<ServiceProvider>;
  getById(id: string): Promise<ServiceProvider | null>;
  list(page: PageRequest): Promise<Page<ServiceProvider>>;
  update(
    id: string,
    patch: UpdateServiceProvider,
    ctx: AuditContext,
  ): Promise<ServiceProvider>;
}
