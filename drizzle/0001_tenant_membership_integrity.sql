-- Membership references already identify both owners. This composite uniqueness lets
-- future Tenant-owned relations point at a membership without losing Tenant identity.
ALTER TABLE memberships ADD CONSTRAINT memberships_tenant_user_unique UNIQUE (tenant_id, user_id);
