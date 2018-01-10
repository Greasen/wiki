/* global wiki */

const Promise = require('bluebird')
const bcrypt = require('bcryptjs-then')
const _ = require('lodash')
const tfa = require('node-2fa')
const securityHelper = require('../helpers/security')

/**
 * Users schema
 */
module.exports = (sequelize, DataTypes) => {
  let userSchema = sequelize.define('user', {
    email: {
      type: DataTypes.STRING,
      allowNull: false,
      validate: {
        isEmail: true
      }
    },
    provider: {
      type: DataTypes.STRING,
      allowNull: false
    },
    providerId: {
      type: DataTypes.STRING,
      allowNull: true
    },
    password: {
      type: DataTypes.STRING,
      allowNull: true
    },
    name: {
      type: DataTypes.STRING,
      allowNull: true
    },
    role: {
      type: DataTypes.ENUM('admin', 'user', 'guest'),
      allowNull: false
    },
    tfaIsActive: {
      type: DataTypes.BOOLEAN,
      allowNull: false,
      defaultValue: false
    },
    tfaSecret: {
      type: DataTypes.STRING,
      allowNull: true
    }
  }, {
    timestamps: true,
    version: true,
    indexes: [
      {
        unique: true,
        fields: ['provider', 'email']
      }
    ]
  })

  userSchema.prototype.validatePassword = async function (rawPwd) {
    if (await bcrypt.compare(rawPwd, this.password) === true) {
      return true
    } else {
      throw new wiki.Error.AuthLoginFailed()
    }
  }

  userSchema.prototype.enableTFA = async function () {
    let tfaInfo = tfa.generateSecret({
      name: wiki.config.site.title
    })
    this.tfaIsActive = true
    this.tfaSecret = tfaInfo.secret
    return this.save()
  }

  userSchema.prototype.disableTFA = async function () {
    this.tfaIsActive = false
    this.tfaSecret = ''
    return this.save()
  }

  userSchema.prototype.verifyTFA = function (code) {
    let result = tfa.verifyToken(this.tfaSecret, code)
    console.info(result)
    return (result && _.has(result, 'delta') && result.delta === 0)
  }

  userSchema.login = async (opts, context) => {
    if (_.has(wiki.config.auth.strategies, opts.provider)) {
      _.set(context.req, 'body.email', opts.username)
      _.set(context.req, 'body.password', opts.password)

      // Authenticate
      return new Promise((resolve, reject) => {
        wiki.auth.passport.authenticate(opts.provider, async (err, user, info) => {
          if (err) { return reject(err) }
          if (!user) { return reject(new wiki.Error.AuthLoginFailed()) }

          // Is 2FA required?
          if (user.tfaIsActive) {
            try {
              let loginToken = await securityHelper.generateToken(32)
              await wiki.redis.set(`tfa:${loginToken}`, user.id, 'EX', 600)
              return resolve({
                succeeded: true,
                message: 'Login Successful. Awaiting 2FA security code.',
                tfaRequired: true,
                tfaLoginToken: loginToken
              })
            } catch (err) {
              wiki.logger.warn(err)
              return reject(new wiki.Error.AuthGenericError())
            }
          } else {
            // No 2FA, log in user
            return context.req.logIn(user, err => {
              if (err) { return reject(err) }
              resolve({
                succeeded: true,
                message: 'Login Successful',
                tfaRequired: false
              })
            })
          }
        })(context.req, context.res, () => {})
      })
    } else {
      throw new wiki.Error.AuthProviderInvalid()
    }
  }

  userSchema.loginTFA = async (opts, context) => {
    if (opts.securityCode.length === 6 && opts.loginToken.length === 64) {
      console.info(opts.loginToken)
      let result = await wiki.redis.get(`tfa:${opts.loginToken}`)
      console.info(result)
      if (result) {
        console.info('DUDE2')
        let userId = _.toSafeInteger(result)
        if (userId && userId > 0) {
          console.info('DUDE3')
          let user = await wiki.db.User.findById(userId)
          if (user && user.verifyTFA(opts.securityCode)) {
            console.info('DUDE4')
            return Promise.fromCallback(clb => {
              context.req.logIn(user, clb)
            }).return({
              succeeded: true,
              message: 'Login Successful'
            }).catch(err => {
              wiki.logger.warn(err)
              throw new wiki.Error.AuthGenericError()
            })
          } else {
            throw new wiki.Error.AuthTFAFailed()
          }
        }
      }
    }
    throw new wiki.Error.AuthTFAInvalid()
  }

  userSchema.processProfile = (profile) => {
    let primaryEmail = ''
    if (_.isArray(profile.emails)) {
      let e = _.find(profile.emails, ['primary', true])
      primaryEmail = (e) ? e.value : _.first(profile.emails).value
    } else if (_.isString(profile.email) && profile.email.length > 5) {
      primaryEmail = profile.email
    } else if (_.isString(profile.mail) && profile.mail.length > 5) {
      primaryEmail = profile.mail
    } else if (profile.user && profile.user.email && profile.user.email.length > 5) {
      primaryEmail = profile.user.email
    } else {
      return Promise.reject(new Error(wiki.lang.t('auth:errors.invaliduseremail')))
    }

    profile.provider = _.lowerCase(profile.provider)
    primaryEmail = _.toLower(primaryEmail)

    return wiki.db.User.findOneAndUpdate({
      email: primaryEmail,
      provider: profile.provider
    }, {
      email: primaryEmail,
      provider: profile.provider,
      providerId: profile.id,
      name: profile.displayName || _.split(primaryEmail, '@')[0]
    }, {
      new: true
    }).then((user) => {
      // Handle unregistered accounts
      if (!user && profile.provider !== 'local' && (wiki.config.auth.defaultReadAccess || profile.provider === 'ldap' || profile.provider === 'azure')) {
        let nUsr = {
          email: primaryEmail,
          provider: profile.provider,
          providerId: profile.id,
          password: '',
          name: profile.displayName || profile.name || profile.cn,
          rights: [{
            role: 'read',
            path: '/',
            exact: false,
            deny: false
          }]
        }
        return wiki.db.User.create(nUsr)
      }
      return user || Promise.reject(new Error(wiki.lang.t('auth:errors:notyetauthorized')))
    })
  }

  userSchema.hashPassword = (rawPwd) => {
    return bcrypt.hash(rawPwd)
  }

  return userSchema
}
