usePlugin("@nomiclabs/buidler-truffle5");
usePlugin("@nomiclabs/buidler-web3");

// This is a sample Buidler task. To learn how to create your own go to
// https://buidler.dev/guides/create-task.html
task("accounts", "Prints the list of accounts", async () => {
  const accounts = await web3.eth.getAccounts();

  for (const account of accounts) {
    console.log(account);
  }
});

module.exports = {
  defaultNetwork: "buidlerevm",

  networks: {
    develop: {
      url: "http://127.0.0.1:8545",
      gas: 6000000,
      timeout: 20000
    },
  },

  solc: {
    version: "0.6.6",
    optimizer: require("./solcOptimiserSettings.js")
  },

  paths: {
    sources: "./contracts/sol6",
    tests: "./test",
  },

  mocha: {
    enableTimeouts: false
  }
};
