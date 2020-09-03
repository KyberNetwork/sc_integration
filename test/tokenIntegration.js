const MockDao = artifacts.require('MockKyberDao.sol');
const FeeHandler = artifacts.require('KyberFeeHandler.sol');
const MatchingEngine = artifacts.require('KyberMatchingEngine.sol');
const KyberNetwork = artifacts.require('KyberNetwork.sol');
const KyberNetworkProxy = artifacts.require('KyberNetworkProxy.sol');
const RateHelper = artifacts.require('KyberRateHelper.sol');

const TestToken = artifacts.require('Token.sol');
const DummyDGX = artifacts.require('DummyDGX.sol');
const DummyDGXStorage = artifacts.require('DummyDGXStorage.sol');

const Helper = require('./helper.js');
const nwHelper = require('./networkHelper.js');

const BN = web3.utils.BN;
const {ethDecimals, ethAddress, zeroAddress, zeroBN} = require('./helper.js');
const {BEST_OF_ALL_HINTTYPE} = require('./networkHelper.js');

//global variables
//////////////////
const gasPrice = new BN(10).pow(new BN(9)).mul(new BN(50));
const negligibleRateDiffBps = new BN(10); //0.01%
const maxDestAmt = new BN(2).pow(new BN(255));
const minConversionRate = new BN(0);

//KyberDao related data
let networkFeeBps = new BN(20);
let platformFeeBps = zeroBN;

let rewardInBPS = new BN(7000);
let rebateInBPS = new BN(2000);
let epoch = new BN(3);
let expiryTimestamp;

//fee hanlder related
let KNC;
let burnBlockInterval = new BN(30);

let admin;
let storage;
let network;
let kyberDao;
let networkProxy;
let feeHandler;
let matchingEngine;
let operator;
let taker;
let platformWallet;

//reserve data
//////////////
let reserveInstances = {};
let reserve;
let numReserves;
let info;
let hint;

//tokens data
////////////
let numTokens = 5;
let tokens = [];
let tokenDecimals = [];

contract('KyberNetwork', function (accounts) {
  before('one time global init', async () => {
    //init accounts
    networkProxy = accounts[0]; // when using account 0 can avoid string ({from: proxy}) in trade call;
    operator = accounts[1];
    alerter = accounts[2];
    taker = accounts[3];
    platformWallet = accounts[4];
    admin = accounts[5]; // we don't want admin as account 0.
    hintParser = accounts[6];

    //KyberDao related init.
    expiryTimestamp = (await Helper.getCurrentBlockTime()) + 10;
    kyberDao = await MockDao.new(rewardInBPS, rebateInBPS, epoch, expiryTimestamp);
    await kyberDao.setNetworkFeeBps(networkFeeBps);

    //init tokens
    for (let i = 0; i < numTokens; i++) {
      tokenDecimals[i] = new BN(15).add(new BN(i));
      token = await TestToken.new('test' + i, 'tst' + i, tokenDecimals[i]);
      tokens[i] = token;
    }
  });

  describe('test trades with MockKyberDao', async () => {
    before('initialise KyberDao, network and reserves', async () => {
      // KyberDao related init.
      expiryTimestamp = (await Helper.getCurrentBlockTime()) + 10;
      kyberDao = await MockDao.new(rewardInBPS, rebateInBPS, epoch, expiryTimestamp);
      await kyberDao.setNetworkFeeBps(networkFeeBps);

      // init storage and network
      storage = await nwHelper.setupStorage(admin);
      network = await KyberNetwork.new(admin, storage.address);
      await storage.setNetworkContract(network.address, {from: admin});
      await storage.addOperator(operator, {from: admin});

      // set proxy same as network
      proxyForFeeHandler = network;

      // init feeHandler
      KNC = await TestToken.new('kyber network crystal', 'KNC', 18);
      feeHandler = await FeeHandler.new(
        kyberDao.address,
        proxyForFeeHandler.address,
        network.address,
        KNC.address,
        burnBlockInterval,
        kyberDao.address
      );

      // init matchingEngine
      matchingEngine = await MatchingEngine.new(admin);
      await matchingEngine.setNetworkContract(network.address, {from: admin});
      await matchingEngine.setKyberStorage(storage.address, {from: admin});
      await storage.setFeeAccountedPerReserveType(true, true, true, false, true, true, {from: admin});
      await storage.setEntitledRebatePerReserveType(true, false, true, false, true, true, {from: admin});

      // init rateHelper
      rateHelper = await RateHelper.new(admin);
      await rateHelper.setContracts(kyberDao.address, storage.address, {
        from: admin
      });

      // init gas helper
      // tests gasHelper when gasHelper != address(0), and when a trade is being done

      // setup network
      await network.setContracts(feeHandler.address, matchingEngine.address, zeroAddress, {from: admin});
      await network.addOperator(operator, {from: admin});
      await network.addKyberProxy(networkProxy, {from: admin});
      await network.setKyberDaoContract(kyberDao.address, {from: admin});
      //set params, enable network
      await network.setParams(gasPrice, negligibleRateDiffBps, {from: admin});
      await network.setEnable(true, {from: admin});
    });

    beforeEach('zero network balance', async () => {
      await Helper.zeroNetworkBalance(network, tokens, admin);
    });

    describe('test with DGX token', async () => {
      let dgxToken;
      let dgxTransferfee = new BN(13);
      let dgxDecimal = new BN(9);
      let trader = accounts[8];
      let networkProxy;
      let tokens;
      before('setup, add and list mock reserves', async () => {
        let dgxStorage = await DummyDGXStorage.new({from: admin});
        dgxToken = await DummyDGX.new(dgxStorage.address, admin);
        await dgxStorage.setInteractive(dgxToken.address, {from: admin});
        // transfer token and add accounts[0] to whitelist so `token.transfer` still works
        await dgxToken.mintDgxFor(accounts[0], new BN(10).pow(new BN(18)), {
          from: admin
        });
        await dgxToken.updateUserFeesConfigs(accounts[0], true, true, {
          from: admin
        });
        // add balance to network
        await dgxToken.mintDgxFor(network.address, new BN(10).pow(new BN(18)), {
          from: admin
        });
        await dgxToken.updateUserFeesConfigs(network.address, true, true, {
          from: admin
        });
        // setup kyberProxy
        networkProxy = await KyberNetworkProxy.new(admin);
        await networkProxy.setKyberNetwork(network.address, {from: admin});
        await network.addKyberProxy(networkProxy.address, {from: admin});
        await dgxToken.updateUserFeesConfigs(networkProxy.address, true, true, {
          from: admin
        });
        tokens = [dgxToken];
        //init reserves
        let result = await nwHelper.setupReserves(network, tokens, 1, 0, 0, 0, accounts, admin, operator);

        reserveInstances = result.reserveInstances;
        numReserves += result.numAddedReserves * 1;

        //add and list pair for reserve
        await nwHelper.addReservesToStorage(storage, reserveInstances, tokens, operator);

        for (const [key, value] of Object.entries(reserveInstances)) {
          reserve = value.instance;
          //add reserves to white list
          await dgxToken.updateUserFeesConfigs(reserve.address, true, true, {
            from: admin
          });
        }
      });

      after('clean up', async () => {
        await network.removeKyberProxy(networkProxy.address, {from: admin});
        await nwHelper.removeReservesFromStorage(storage, reserveInstances, tokens, operator);
        reserveInstances = {};
      });

      it('should success when e2t with dgx, network not pays fee', async () => {
        let ethSrcQty = new BN(10).pow(new BN(18));
        let hintType = BEST_OF_ALL_HINTTYPE;
        hint = await nwHelper.getHint(
          rateHelper,
          matchingEngine,
          reserveInstances,
          hintType,
          undefined,
          ethAddress,
          dgxToken.address,
          ethSrcQty
        );

        info = [ethSrcQty, networkFeeBps, platformFeeBps];

        expectedResult = await nwHelper.getAndCalcRates(
          matchingEngine,
          storage,
          reserveInstances,
          ethAddress,
          dgxToken.address,
          ethSrcQty,
          ethDecimals,
          dgxDecimal,
          networkFeeBps,
          platformFeeBps,
          hint
        );

        let initialReserveBalances = await nwHelper.getReserveBalances(ethAddress, dgxToken, expectedResult);
        let initialTakerBalances = await nwHelper.getTakerBalances(ethAddress, dgxToken, taker);
        let initialNetworkDgxBalance = await dgxToken.balanceOf(network.address);
        [expectedResult, actualSrcQty] = await nwHelper.calcParamsFromMaxDestAmt(
          ethAddress,
          dgxToken,
          expectedResult,
          info,
          maxDestAmt
        );

        await networkProxy.tradeWithHintAndFee(
          ethAddress,
          ethSrcQty,
          dgxToken.address,
          taker,
          maxDestAmt,
          minConversionRate,
          zeroAddress,
          platformFeeBps,
          hint,
          {value: ethSrcQty, from: taker, gasPrice: new BN(0)}
        );

        await nwHelper.compareBalancesAfterTrade(
          ethAddress,
          dgxToken,
          actualSrcQty,
          initialReserveBalances,
          initialTakerBalances,
          expectedResult,
          taker
        );

        //because network is in whitelist so fee is not change
        await Helper.assertSameTokenBalance(network.address, dgxToken, initialNetworkDgxBalance);
      });

      it('should success when t2e with dgx, network pays fee', async () => {
        let srcQty = new BN(10).pow(new BN(9));
        let hintType = BEST_OF_ALL_HINTTYPE;
        hint = await nwHelper.getHint(
          rateHelper,
          matchingEngine,
          reserveInstances,
          hintType,
          undefined,
          dgxToken.address,
          ethAddress,
          srcQty
        );

        info = [srcQty, networkFeeBps, platformFeeBps];

        expectedResult = await nwHelper.getAndCalcRates(
          matchingEngine,
          storage,
          reserveInstances,
          dgxToken.address,
          ethAddress,
          srcQty,
          dgxDecimal,
          ethDecimals,
          networkFeeBps,
          platformFeeBps,
          hint
        );
        await dgxToken.mintDgxFor(trader, srcQty, {from: admin});

        let initialReserveBalances = await nwHelper.getReserveBalances(dgxToken, ethAddress, expectedResult);
        let initialTakerBalances = await nwHelper.getTakerBalances(dgxToken, ethAddress, taker, trader);
        let initialNetworkDgxBalance = await dgxToken.balanceOf(network.address);
        [expectedResult, actualSrcQty] = await nwHelper.calcParamsFromMaxDestAmt(
          dgxToken,
          ethAddress,
          expectedResult,
          info,
          maxDestAmt
        );
        //inside the tradeflow
        await dgxToken.approve(networkProxy.address, srcQty, {from: trader});
        await networkProxy.tradeWithHintAndFee(
          dgxToken.address,
          srcQty,
          ethAddress,
          taker,
          maxDestAmt,
          minConversionRate,
          zeroAddress,
          platformFeeBps,
          hint,
          {from: trader}
        );

        await nwHelper.compareBalancesAfterTrade(
          dgxToken,
          ethAddress,
          srcQty,
          initialReserveBalances,
          initialTakerBalances,
          expectedResult,
          taker,
          trader
        );
        //because trader(kyberProxy) is not in whitelist so fee is 0.13%
        let dgxFee = actualSrcQty.mul(dgxTransferfee).div(new BN(10000));
        let expectedNewBalance = initialNetworkDgxBalance.sub(dgxFee);
        await Helper.assertSameTokenBalance(network.address, dgxToken, expectedNewBalance);
      });

      it('should success when t2e with dgx, network pays fee with maxDestAmount', async () => {
        let srcQty = new BN(10).pow(new BN(9));
        let hintType = BEST_OF_ALL_HINTTYPE;
        hint = await nwHelper.getHint(
          rateHelper,
          matchingEngine,
          reserveInstances,
          hintType,
          undefined,
          dgxToken.address,
          ethAddress,
          srcQty
        );

        info = [srcQty, networkFeeBps, platformFeeBps];

        expectedResult = await nwHelper.getAndCalcRates(
          matchingEngine,
          storage,
          reserveInstances,
          dgxToken.address,
          ethAddress,
          srcQty,
          dgxDecimal,
          ethDecimals,
          networkFeeBps,
          platformFeeBps,
          hint
        );
        await dgxToken.mintDgxFor(trader, srcQty, {from: admin});

        let initialReserveBalances = await nwHelper.getReserveBalances(dgxToken, ethAddress, expectedResult);
        let initialTakerBalances = await nwHelper.getTakerBalances(dgxToken, ethAddress, taker, trader);
        let initialNetworkDgxBalance = await dgxToken.balanceOf(network.address);
        let maxDestAmt = expectedResult.actualDestAmount.div(new BN(2));
        [expectedResult, actualSrcQty] = await nwHelper.calcParamsFromMaxDestAmt(
          dgxToken,
          ethAddress,
          expectedResult,
          info,
          maxDestAmt
        );
        await dgxToken.approve(networkProxy.address, srcQty, {from: trader});
        await networkProxy.tradeWithHintAndFee(
          dgxToken.address,
          srcQty,
          ethAddress,
          taker,
          maxDestAmt,
          minConversionRate,
          zeroAddress,
          platformFeeBps,
          hint,
          {from: trader}
        );

        await nwHelper.compareBalancesAfterTrade(
          dgxToken,
          ethAddress,
          actualSrcQty,
          initialReserveBalances,
          initialTakerBalances,
          expectedResult,
          taker,
          trader
        );
        //because trader(kyberProxy) is not in whitelist so fee is 0.13% of srcQty
        let dgxFee = srcQty.mul(dgxTransferfee).div(new BN(10000));
        let expectedNewBalance = initialNetworkDgxBalance.sub(dgxFee);
        await Helper.assertSameTokenBalance(network.address, dgxToken, expectedNewBalance);
      });
    });
  });
});
