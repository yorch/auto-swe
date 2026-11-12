INSERT INTO organization_memberships (user_id, org_id, role)
SELECT DISTINCT tm.user_id, t.org_id, 'ORG_MEMBER'::"OrgRole"
FROM team_memberships tm
JOIN teams t ON t.id = tm.team_id
WHERE NOT EXISTS (
  SELECT 1 FROM organization_memberships om
  WHERE om.user_id = tm.user_id AND om.org_id = t.org_id
)
ON CONFLICT DO NOTHING;
