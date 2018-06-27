# ecr-access-manager
Sets access policies on ECR repositories for other AWS accounts

## How to use
Add a parameter named "/ecr/pull/ACCOUNT_ID" where ACCOUNT_ID is the 12 digit AWS account identifier. The value should be a String list such as "namespace1,namespace2", pointing out which namespaces the AWS account will get pull access to. The namespace is the part between the first forward slashes, e.g. "namespace1" for the repository named "/namespace1/reponame1".

The function is triggered both when a parameter is added, changed or deleted, and when a new repository is created.
