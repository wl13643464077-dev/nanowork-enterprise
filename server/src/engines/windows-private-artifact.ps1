# Windows-only helper for generated artifacts; no recursive ACL operations.
param([ValidateSet('create', 'protect', 'inspect', 'ensure-files', 'ensure-directory')][string]$Operation = 'inspect')
$ErrorActionPreference = 'Stop'
[Console]::InputEncoding = [System.Text.UTF8Encoding]::new($false)
[Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false)
$request = [Console]::In.ReadToEnd() | ConvertFrom-Json
$identity = [System.Security.Principal.WindowsIdentity]::GetCurrent().User
$trusted = @($identity.Value, 'S-1-5-18', 'S-1-5-32-544')
$result = @()
foreach ($requestedPath in @($request.paths)) {
    if (-not [System.IO.Path]::IsPathRooted($requestedPath)) { throw 'Expected absolute artifact path' }
    $pathOperation = $Operation
    if ($Operation -eq 'ensure-files') {
        if ([System.IO.File]::Exists($requestedPath)) { $pathOperation = 'protect' }
        else { $pathOperation = 'create' }
    }
    if ($pathOperation -eq 'ensure-directory' -and -not [System.IO.Directory]::Exists($requestedPath)) {
        if (-not [System.IO.Directory]::Exists([System.IO.Path]::GetDirectoryName($requestedPath))) {
            throw 'Private data directory parent must already exist'
        }
        $directorySecurity = [System.Security.AccessControl.DirectorySecurity]::new()
        $directorySecurity.SetOwner($identity)
        $directorySecurity.SetAccessRuleProtection($true, $false)
        foreach ($sid in $trusted) {
            $directorySecurity.AddAccessRule([System.Security.AccessControl.FileSystemAccessRule]::new(
                [System.Security.Principal.SecurityIdentifier]::new($sid),
                [System.Security.AccessControl.FileSystemRights]::FullControl,
                ([System.Security.AccessControl.InheritanceFlags]::ContainerInherit -bor [System.Security.AccessControl.InheritanceFlags]::ObjectInherit),
                [System.Security.AccessControl.PropagationFlags]::None,
                [System.Security.AccessControl.AccessControlType]::Allow))
        }
        [void][System.IO.Directory]::CreateDirectory($requestedPath, $directorySecurity)
    }
    if ($pathOperation -eq 'create') {
        # Apply the DACL at CreateNew, not after a publicly inherited empty file
        # is visible: an already-open reader handle would survive a later ACL change.
        $security = [System.Security.AccessControl.FileSecurity]::new()
        $security.SetOwner($identity)
        $security.SetAccessRuleProtection($true, $false)
        foreach ($sid in $trusted) {
            $principal = [System.Security.Principal.SecurityIdentifier]::new($sid)
            $security.AddAccessRule([System.Security.AccessControl.FileSystemAccessRule]::new(
                $principal, [System.Security.AccessControl.FileSystemRights]::FullControl,
                [System.Security.AccessControl.AccessControlType]::Allow))
        }
        $stream = [System.IO.FileStream]::new($requestedPath, [System.IO.FileMode]::CreateNew,
            [System.Security.AccessControl.FileSystemRights]::Modify, [System.IO.FileShare]::None,
            4096, [System.IO.FileOptions]::None, $security)
        $stream.Dispose()
    }
    $item = Get-Item -LiteralPath $requestedPath -Force
    if (($item.Attributes -band [System.IO.FileAttributes]::ReparsePoint) -ne 0) {
        throw 'Refusing reparse-point ACL operation'
    }
    $acl = $item.GetAccessControl()
    if ($pathOperation -in @('protect', 'ensure-directory')) {
        if (($pathOperation -eq 'ensure-directory') -ne $item.PSIsContainer) { throw 'Private path kind mismatch' }
        # Do not take ownership or adjust an unrelated owner's file.
        if ($acl.GetOwner([System.Security.Principal.SecurityIdentifier]).Value -ne $identity.Value) {
            throw 'Refusing to change ACL of a file not owned by the running account'
        }
        $acl.SetAccessRuleProtection($true, $false)
        foreach ($rule in @($acl.GetAccessRules($true, $false, [System.Security.Principal.SecurityIdentifier]))) {
            $acl.RemoveAccessRuleSpecific($rule)
        }
        foreach ($sid in $trusted) {
            $principal = [System.Security.Principal.SecurityIdentifier]::new($sid)
            if ($item.PSIsContainer) {
                $rule = [System.Security.AccessControl.FileSystemAccessRule]::new(
                    $principal, [System.Security.AccessControl.FileSystemRights]::FullControl,
                    ([System.Security.AccessControl.InheritanceFlags]::ContainerInherit -bor [System.Security.AccessControl.InheritanceFlags]::ObjectInherit),
                    [System.Security.AccessControl.PropagationFlags]::None,
                    [System.Security.AccessControl.AccessControlType]::Allow)
            } else {
                $rule = [System.Security.AccessControl.FileSystemAccessRule]::new(
                    $principal, [System.Security.AccessControl.FileSystemRights]::FullControl,
                    [System.Security.AccessControl.AccessControlType]::Allow)
            }
            $acl.AddAccessRule($rule)
        }
        $item.SetAccessControl($acl)
        $acl = $item.GetAccessControl()
    }
    $rules = @($acl.GetAccessRules($true, $true, [System.Security.Principal.SecurityIdentifier]))
    $owner = $acl.GetOwner([System.Security.Principal.SecurityIdentifier]).Value
    $unsafe = @($rules | Where-Object {
        $_.AccessControlType -eq [System.Security.AccessControl.AccessControlType]::Allow -and
        $_.IdentityReference.Value -notin $trusted
    })
    $ownFullControl = @($rules | Where-Object {
        $_.AccessControlType -eq [System.Security.AccessControl.AccessControlType]::Allow -and
        $_.IdentityReference.Value -eq $identity.Value -and
        ($_.FileSystemRights -band [System.Security.AccessControl.FileSystemRights]::FullControl) -eq
            [System.Security.AccessControl.FileSystemRights]::FullControl
    })
    $restricted = $owner -eq $identity.Value -and
        $unsafe.Count -eq 0 -and $ownFullControl.Count -gt 0
    $private = $acl.AreAccessRulesProtected -and $restricted
    if ($item.PSIsContainer) {
        $descendantsProtected = @($ownFullControl | Where-Object {
            ($_.InheritanceFlags -band [System.Security.AccessControl.InheritanceFlags]::ContainerInherit) -ne 0 -and
            ($_.InheritanceFlags -band [System.Security.AccessControl.InheritanceFlags]::ObjectInherit) -ne 0 -and
            $_.PropagationFlags -eq [System.Security.AccessControl.PropagationFlags]::None
        }).Count -gt 0
        $private = $private -and $descendantsProtected
    }
    if ($Operation -ne 'inspect' -and -not $private) { throw 'Private artifact ACL readback failed' }
    $result += [pscustomobject]@{
        path = $item.FullName
        private = [bool]$private
        restricted = [bool]$restricted
        sddl = $acl.GetSecurityDescriptorSddlForm([System.Security.AccessControl.AccessControlSections]::Access -bor
            [System.Security.AccessControl.AccessControlSections]::Owner -bor
            [System.Security.AccessControl.AccessControlSections]::Group)
    }
}
ConvertTo-Json -InputObject @($result) -Depth 4 -Compress
