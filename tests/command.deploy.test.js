const test = require('ava')
const { getToken } = require('../src/utils/command')
const fetch = require('node-fetch')
const { withSiteBuilder } = require('./utils/siteBuilder')
const callCli = require('./utils/callCli')
const { generateSiteName, createLiveTestSite } = require('./utils/createLiveTestSite')

const siteName = generateSiteName('netlify-test-deploy-')

const validateContent = async ({ siteUrl, path, content, t }) => {
  let actualContent
  try {
    const response = await fetch(`${siteUrl}${path}`)
    if (response.ok) {
      actualContent = await response.text()
    }
  } catch (e) {
    // no op
  }
  t.is(actualContent, content)
}

const validateDeploy = async ({ deploy, siteName, content, t }) => {
  t.truthy(deploy.site_name)
  t.truthy(deploy.deploy_url)
  t.truthy(deploy.deploy_id)
  t.truthy(deploy.logs)
  t.is(deploy.site_name, siteName)

  await validateContent({ siteUrl: deploy.deploy_url, path: '', content, t })
}

if (process.env.IS_FORK !== 'true') {
  test.before(async t => {
    const siteId = await createLiveTestSite(siteName)
    t.context.siteId = siteId
  })

  test.serial('should deploy site when dir flag is passed', async t => {
    await withSiteBuilder('site-with-public-folder', async builder => {
      const content = '<h1>⊂◉‿◉つ</h1>'
      builder.withContentFile({
        path: 'public/index.html',
        content,
      })

      await builder.buildAsync()

      const deploy = await callCli(['deploy', '--json', '--dir', 'public'], {
        cwd: builder.directory,
        env: { NETLIFY_SITE_ID: t.context.siteId },
      }).then(output => JSON.parse(output))

      await validateDeploy({ deploy, siteName, content, t })
    })
  })

  test.serial('should deploy site when publish directory set in netlify.toml', async t => {
    await withSiteBuilder('site-with-public-folder', async builder => {
      const content = '<h1>⊂◉‿◉つ</h1>'
      builder
        .withContentFile({
          path: 'public/index.html',
          content,
        })
        .withNetlifyToml({
          config: {
            build: { publish: 'public' },
          },
        })

      await builder.buildAsync()

      const deploy = await callCli(['deploy', '--json'], {
        cwd: builder.directory,
        env: { NETLIFY_SITE_ID: t.context.siteId },
      }).then(output => JSON.parse(output))

      await validateDeploy({ deploy, siteName, content, t })
    })
  })

  // the edge handlers plugin only works on node >= 10 and not on windows at the moment
  const version = parseInt(process.version.substring(1).split('.')[0])
  if (process.platform !== 'win32' && version >= 10) {
    test.serial('should deploy edge handlers when directory exists', async t => {
      await withSiteBuilder('site-with-public-folder', async builder => {
        const content = '<h1>⊂◉‿◉つ</h1>'
        builder
          .withContentFile({
            path: 'public/index.html',
            content,
          })
          .withNetlifyToml({
            config: {
              build: { publish: 'public', command: 'echo "no op"' },
            },
          })
          .withEdgeHandlers({
            handlers: {
              onRequest: event => {
                console.log(`Incoming request for ${event.request.url}`)
              },
            },
          })

        await builder.buildAsync()

        const options = {
          cwd: builder.directory,
          env: { NETLIFY_SITE_ID: t.context.siteId },
        }
        // build the edge handlers first
        await callCli(['build'], options)
        const deploy = await callCli(['deploy', '--json'], options).then(output => JSON.parse(output))

        await validateDeploy({ deploy, siteName, content, t })

        // validate edge handlers
        // use this until we can use `netlify api`
        const [apiToken] = getToken()
        const resp = await fetch(`https://api.netlify.com/api/v1/deploys/${deploy.deploy_id}/edge_handlers`, {
          headers: {
            'Content-Type': 'application/json',
            'Authorization': `Bearer ${apiToken}`,
          },
        })

        t.is(resp.status, 200)
        const { created_at, sha, content_length, ...rest } = await resp.json()
        t.deepEqual(rest, {
          content_type: 'application/javascript',
          handlers: ['index'],
          valid: true,
        })
        t.is(content_length > 50, true)
      })
    })
  }

  test.serial('should run build command before deploy when build flag is passed', async t => {
    await withSiteBuilder('site-with-public-folder', async builder => {
      const content = '<h1>⊂◉‿◉つ</h1>'
      builder
        .withContentFile({
          path: 'public/index.html',
          content,
        })
        .withNetlifyToml({
          config: {
            build: { publish: 'public' },
          },
        })

      await builder.buildAsync()

      const output = await callCli(['deploy', '--build'], {
        cwd: builder.directory,
        env: { NETLIFY_SITE_ID: t.context.siteId },
      })

      t.is(output.includes('Netlify Build completed in'), true)
    })
  })

  test.serial('should deploy hidden public folder but ignore hidden/__MACOSX files', async t => {
    await withSiteBuilder('site-with-a-dedicated-publish-folder', async builder => {
      builder
        .withContentFiles([
          {
            path: '.public/index.html',
            content: 'index',
          },
          {
            path: '.public/.hidden-file.html',
            content: 'hidden-file',
          },
          {
            path: '.public/.hidden-dir/index.html',
            content: 'hidden-dir',
          },
          {
            path: '.public/__MACOSX/index.html',
            content: 'macosx',
          },
        ])
        .withNetlifyToml({
          config: {
            build: { publish: '.public' },
          },
        })

      await builder.buildAsync()

      const deploy = await callCli(['deploy', '--json'], {
        cwd: builder.directory,
        env: { NETLIFY_SITE_ID: t.context.siteId },
      }).then(output => JSON.parse(output))

      await validateDeploy({ deploy, siteName, content: 'index', t })
      await validateContent({
        siteUrl: deploy.deploy_url,
        content: undefined,
        path: '/.hidden-file',
        t,
      })
      await validateContent({
        siteUrl: deploy.deploy_url,
        content: undefined,
        path: '/.hidden-dir',
        t,
      })
      await validateContent({
        siteUrl: deploy.deploy_url,
        content: undefined,
        path: '/__MACOSX',
        t,
      })
    })
  })

  test.serial('should filter node_modules from root directory', async t => {
    await withSiteBuilder('site-with-a-project-directory', async builder => {
      builder
        .withContentFiles([
          {
            path: 'index.html',
            content: 'index',
          },
          {
            path: 'node_modules/package.json',
            content: '{}',
          },
        ])
        .withNetlifyToml({
          config: {
            build: { publish: '.' },
          },
        })

      await builder.buildAsync()

      const deploy = await callCli(['deploy', '--json'], {
        cwd: builder.directory,
        env: { NETLIFY_SITE_ID: t.context.siteId },
      }).then(output => JSON.parse(output))

      await validateDeploy({ deploy, siteName, content: 'index', t })
      await validateContent({
        siteUrl: deploy.deploy_url,
        content: undefined,
        path: '/node_modules/package.json',
        t,
      })
    })
  })

  test.serial('should not filter node_modules from publish directory', async t => {
    await withSiteBuilder('site-with-a-project-directory', async builder => {
      builder
        .withContentFiles([
          {
            path: 'public/index.html',
            content: 'index',
          },
          {
            path: 'public/node_modules/package.json',
            content: '{}',
          },
        ])
        .withNetlifyToml({
          config: {
            build: { publish: 'public' },
          },
        })

      await builder.buildAsync()

      const deploy = await callCli(['deploy', '--json'], {
        cwd: builder.directory,
        env: { NETLIFY_SITE_ID: t.context.siteId },
      }).then(output => JSON.parse(output))

      await validateDeploy({ deploy, siteName, content: 'index', t })
      await validateContent({
        siteUrl: deploy.deploy_url,
        content: '{}',
        path: '/node_modules/package.json',
        t,
      })
    })
  })

  test('should exit with error when deploying an empty directory', async t => {
    await withSiteBuilder('site-with-an-empty-directory', async builder => {
      await builder.buildAsync()

      try {
        await callCli(['deploy', '--dir', '.'], {
          cwd: builder.directory,
          env: { NETLIFY_SITE_ID: t.context.siteId },
        })
      } catch (e) {
        t.is(e.stderr.includes('Error: No files or functions to deploy'), true)
      }
    })
  })

  test.after('cleanup', async t => {
    const { siteId } = t.context
    console.log(`deleting test site "${siteName}". ${siteId}`)
    await callCli(['sites:delete', siteId, '--force'])
  })
}
