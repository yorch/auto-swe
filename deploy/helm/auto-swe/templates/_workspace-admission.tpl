{{- define "auto-swe.workspaceAdmission" -}}
apiVersion: admissionregistration.k8s.io/v1
kind: ValidatingAdmissionPolicy
metadata:
  name: {{ .Values.workspaces.namespace }}-pods
spec:
  failurePolicy: Fail
  matchConstraints:
    namespaceSelector:
      matchLabels:
        kubernetes.io/metadata.name: {{ .Values.workspaces.namespace | quote }}
    resourceRules:
      - apiGroups: [""]
        apiVersions: [v1]
        operations: [CREATE, UPDATE]
        resources: [pods, pods/ephemeralcontainers]
  validations:
    - expression: "has(object.metadata.labels) && 'asw/role' in object.metadata.labels && object.metadata.labels['asw/role'] == 'workspace'"
      message: "asw/role must be workspace"
    - expression: "has(object.spec.automountServiceAccountToken) && !object.spec.automountServiceAccountToken"
      message: "service account token automount must be false"
    - expression: "(!has(object.spec.serviceAccountName) || object.spec.serviceAccountName == 'default' || (has(namespaceObject.metadata.labels) && 'asw/workspace-service-account' in namespaceObject.metadata.labels && object.spec.serviceAccountName == namespaceObject.metadata.labels['asw/workspace-service-account']))"
      message: "only the default or designated workspace service account is allowed"
    - expression: "!has(namespaceObject.metadata.labels) || !('asw/required-runtime-class' in namespaceObject.metadata.labels) || (has(object.spec.runtimeClassName) && object.spec.runtimeClassName == namespaceObject.metadata.labels['asw/required-runtime-class'])"
      message: "workspace runtimeClassName must match the required namespace runtime class"
    - expression: "!has(object.spec.volumes) || object.spec.volumes.all(v, has(v.emptyDir) || has(v.configMap) || has(v.downwardAPI) || (has(v.projected) && v.projected.sources.all(s, has(s.configMap) || has(s.downwardAPI))))"
      message: "only emptyDir, configMap and downwardAPI volumes or projections are allowed"
    - expression: "object.spec.containers.all(c, (!has(c.envFrom) || size(c.envFrom) == 0) && (!has(c.env) || c.env.all(e, !has(e.valueFrom) || !has(e.valueFrom.secretKeyRef) || e.valueFrom.secretKeyRef.name == object.metadata.name + '-env'))) && (!has(object.spec.initContainers) || object.spec.initContainers.all(c, (!has(c.envFrom) || size(c.envFrom) == 0) && (!has(c.env) || c.env.all(e, !has(e.valueFrom) || !has(e.valueFrom.secretKeyRef) || e.valueFrom.secretKeyRef.name == object.metadata.name + '-env')))) && (!has(object.spec.ephemeralContainers) || object.spec.ephemeralContainers.all(c, (!has(c.envFrom) || size(c.envFrom) == 0) && (!has(c.env) || c.env.all(e, !has(e.valueFrom) || !has(e.valueFrom.secretKeyRef) || e.valueFrom.secretKeyRef.name == object.metadata.name + '-env'))))"
      message: "envFrom is forbidden; secretKeyRef must name this pod's own -env Secret"
    - expression: "object.spec.containers.all(c, (!has(c.securityContext) || ((!has(c.securityContext.runAsUser) || c.securityContext.runAsUser != 0) && (!has(c.securityContext.capabilities) || !has(c.securityContext.capabilities.add) || size(c.securityContext.capabilities.add) == 0))) || (c.name != 'workspace' && c.name.matches('^[a-z][a-z0-9-]{0,30}$') && has(c.securityContext) && has(c.securityContext.runAsUser) && c.securityContext.runAsUser == 0 && has(c.securityContext.runAsGroup) && c.securityContext.runAsGroup == 0 && has(c.securityContext.runAsNonRoot) && !c.securityContext.runAsNonRoot && has(c.securityContext.allowPrivilegeEscalation) && !c.securityContext.allowPrivilegeEscalation && has(c.securityContext.capabilities) && has(c.securityContext.capabilities.drop) && c.securityContext.capabilities.drop == ['ALL'] && has(c.securityContext.capabilities.add) && size(c.securityContext.capabilities.add) == 5 && ['CHOWN','SETUID','SETGID','FOWNER','DAC_OVERRIDE'].all(cap, cap in c.securityContext.capabilities.add))) && (!has(object.spec.initContainers) || object.spec.initContainers.all(c, !has(c.securityContext) || ((!has(c.securityContext.runAsUser) || c.securityContext.runAsUser != 0) && (!has(c.securityContext.capabilities) || !has(c.securityContext.capabilities.add) || size(c.securityContext.capabilities.add) == 0)))) && (!has(object.spec.ephemeralContainers) || object.spec.ephemeralContainers.all(c, !has(c.securityContext) || ((!has(c.securityContext.runAsUser) || c.securityContext.runAsUser != 0) && (!has(c.securityContext.capabilities) || !has(c.securityContext.capabilities.add) || size(c.securityContext.capabilities.add) == 0))))"
      message: "root and added capabilities are limited to the exact preview service profile; PodSecurity restricted still applies"
---
apiVersion: admissionregistration.k8s.io/v1
kind: ValidatingAdmissionPolicyBinding
metadata:
  name: {{ .Values.workspaces.namespace }}-pods
spec:
  policyName: {{ .Values.workspaces.namespace }}-pods
  validationActions: [Deny]
  matchResources:
    namespaceSelector:
      matchLabels:
        kubernetes.io/metadata.name: {{ .Values.workspaces.namespace | quote }}
{{- end }}
