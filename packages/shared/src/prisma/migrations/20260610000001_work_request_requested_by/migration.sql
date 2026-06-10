-- PROD-10: requester attribution. Who asked the agent to do this?
ALTER TABLE "work_requests"
  ADD COLUMN "requested_by_id" UUID
    REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;
