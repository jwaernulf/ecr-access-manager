'use strict';
let AWS = require('aws-sdk');
const ssm = new AWS.SSM();
const ecr = new AWS.ECR();

function makePolicyStatement(accountId, access) {
  let actions = [];
  let pullActions = [
    "ecr:GetDownloadUrlForLayer",
    "ecr:BatchGetImage",
    "ecr:BatchCheckLayerAvailability"
  ];
  let pushActions = [
     "ecr:PutImage",
     "ecr:InitiateLayerUpload",
     "ecr:UploadLayerPart",
     "ecr:CompleteLayerUpload"
  ];
  if (access === 'PULL') {
    actions = pullActions;
  } else if (access === 'PUSH') {
    actions = pullActions.concat(pushActions);
  }
  return {
    "Sid": "readAccess" + accountId,
    "Effect": "Allow",
    "Principal": {
      "AWS": "arn:aws:iam::" + accountId + ":root"
    },
    "Action": actions
  }
}

async function findAllAccountsWithPullAccess (namespace) {
  let allParams = await ssm.getParametersByPath({
    Path: '/ecr/pull/',
    Recursive: true
  }).promise();
  let accountIds = [];
  for (let param of allParams.Parameters) {
    console.log('Name: ' + param.Name);
    console.log('Type: ' + param.Type);
    console.log('Value: ' + param.Value);
    let accountId = param.Name.split('/')[3];
    let namespaces = param.Value.split(',');
    for (let ns of namespaces) {
      if (ns === namespace) {
        accountIds.push(accountId);
        break;
      }
    }
  }
  console.log('Return: ' + JSON.stringify(accountIds));
  return accountIds;
}

async function getPreviousVersionNamespaces(parameter, currentVersion) {
  let history = await ssm.getParameterHistory({
    Name: parameter
  }).promise();
  if (history.Parameters[history.Parameters.length - 1].Version !== currentVersion) {
    console.log('events coming late or out of order, last: ' + history.Parameters[history.Parameters.length - 1].Version + ', current: ' + currentVersion);
  }
  console.log('previous : ' + history.Parameters[history.Parameters.length - 2].Version + ', current: ' + currentVersion);
  return history.Parameters[history.Parameters.length - 2].Value.split(',');
}

async function givePullRightToAccounts(repositoryName, accountIds) {
  let statement = [];
  for (let accountId of accountIds) {
    statement.push(makePolicyStatement(accountId, 'PULL'));
  }
  let statementString = JSON.stringify({"Statement": statement});
  console.log('PolicyText: ' + statementString);
  return await ecr.setRepositoryPolicy({
    repositoryName: repositoryName,
    policyText: statementString
  }).promise();
}

async function setPolicyStatementForAccount(repositoryName, accountId, access) {
  // access === (NONE | PULL | PUSH)
  console.log(accountId + ' gets ' + access + ' to ' + repositoryName);
  let newStatement = [];
  let policy = await ecr.getRepositoryPolicy({repositoryName: repositoryName}).promise();
  let statements = JSON.parse(policy.policyText).Statement;
  console.log('Statement string: ' + JSON.stringify(statements));
  for (let statement of statements) {
    let statementAccountId = statement.Principal.AWS.match(/[0-9]{12}/);
    if ((statementAccountId + '') !== (accountId + '')) {
      newStatement.push(statement);
    }
  }
  if (access === 'PULL') {
    newStatement.push(makePolicyStatement(accountId, access));
  }
  let statementString = JSON.stringify({"Statement": newStatement});
  console.log('PolicyText for account: ' + JSON.stringify({
    repositoryName: repositoryName,
    policyText: statementString
  }));
  return await ecr.setRepositoryPolicy({
    repositoryName: repositoryName,
    policyText: statementString
  }).promise();
}

async function listAllRepositories() {
  let data = await ecr.describeRepositories({}).promise();
//  console.log('repositories: ' + JSON.stringify(data));
  //TODO call again if there are more than 100 repositories
  let result = [];
  for (let repo of data.repositories) {
    result.push(repo.repositoryName);
  }
  console.log('returning repositories: ' + JSON.stringify(result));
  return result;
}

exports.handler = async (event, _context) => {
//  console.log("event: " + JSON.stringify(event, null, 3));

  if (event.source === "aws.ecr" && event.detail.eventName === "CreateRepository") {
    // Add Rights for all accounts with rights to access namespace
    // event.detail.responseElements.repository.repositoryName === "namespace/repository"
    const namespace = event.detail.responseElements.repository.repositoryName.split('/')[0];
    const accountIds = await findAllAccountsWithPullAccess(namespace);
    await givePullRightToAccounts(
      event.detail.responseElements.repository.repositoryName,
      accountIds);
  } else if (event.source === "aws.ssm") {
    let currentNamespaces,
      removedNamespaces = [],
      addedNamespaces = [],
      previousNamespaces = [],
      accountId;
    if (event['detail-type'] === "AWS API Call via CloudTrail" && event.detail.eventName === "PutParameter") {
      currentNamespaces = event.detail.requestParameters.value.split(',');
      accountId = event.detail.requestParameters.name.split('/')[3];
      if (event.detail.responseElements.version > 1) {
        previousNamespaces = await getPreviousVersionNamespaces(
          event.detail.requestParameters.name,
          event.detail.responseElements.version);
        for (let namespace of previousNamespaces) {
          if (!currentNamespaces.includes(namespace)) {
            removedNamespaces.push(namespace);
          }
        }
      }
      for (let namespace of currentNamespaces) {
        if (!previousNamespaces.includes(namespace)) {
          addedNamespaces.push(namespace);
        }
      }
    } else if (event['detail-type'] === "Parameter Store Change" && event.detail.operation === "Delete") {
      accountId = event.detail.name.split('/')[3];
    } else {
      // Shouldn't reach this, log
      console.log("unhandled AWS API Call via CloudTrail: " + JSON.stringify(event));
      return;
    }
    console.log('state: ' + JSON.stringify({
      previous: previousNamespaces,
      current: currentNamespaces,
      added: addedNamespaces,
      removed: removedNamespaces
    }));
    for (let repository of await listAllRepositories()) {
      let namespace = repository.split('/')[0];
      if (addedNamespaces.includes(namespace)) {
        console.log('Add: ' + repository);
        await setPolicyStatementForAccount(repository, accountId, 'PULL');
      } else if (removedNamespaces.includes(namespace) || event.detail.operation === "Delete") {
        console.log('Remove: ' + repository);
        await setPolicyStatementForAccount(repository, accountId, 'NONE');
      }
    }
  } else {
    // Shouldn't reach this, log
    console.log("unhandled event: " + JSON.stringify(event));
  }
};
